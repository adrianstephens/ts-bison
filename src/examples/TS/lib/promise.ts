/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	Promise (async/await)
//-----------------------------------------------------------------------------

// A minimal, internally-synchronous Promise<T> -- this compiler has no host-driven asynchrony at all
// (no timer/fetch/IO imports anywhere), so "pending" only ever means "waiting on some other compiled
// code to call resolve()", never real external I/O. Rejection/'.catch' isn't modeled (no try/catch
// exists yet either, a separate pre-existing gap) -- a Promise that's never resolved just never fires
// its callbacks.
// 'resolve' is a real public method instead of an executor-only callback, which is all
// `async`/`await` codegen itself needs (it always resolves its own result Promise directly, never
// through a captured closure). The standard 'new Promise((resolve, reject) => ...)' executor form
// isn't modeled -- a real, separate gap (see towasm.ts's own top-of-file comment). The constructor's
// own `initial` param exists only because every field needs a real assignment somewhere in the
// constructor and there's no generic "default T" expressible in source for an unconstrained type
// param -- `value` is overwritten for real the moment `resolve()` runs (guarded by `settled`
// everywhere it's read), so `initial`'s own value never actually matters.
export class Promise<T> {
	private settled: boolean;
	private value: T;
	private callbacks: Array<(value: T) => void>;

	constructor(initial: T) {
		this.settled = false;
		this.value = initial;
		this.callbacks = [];
	}

	resolve(value: T): void {
		if (this.settled)
			return;
		this.settled = true;
		this.value = value;
		// 'for...of' desugars to the same index-read-into-a-local shape as the array case below, so 'cb'
		// is already a plain local by the time it's called -- calling a closure read straight off an
		// array element in one expression ('cbs[i](value)') isn't supported (see towasm.ts's own gap
		// comment), a real local of closure type already is.
		for (const cb of this.callbacks)
			cb(value);
	}

	then(onFulfilled: (value: T) => void): void {
		if (this.settled)
			onFulfilled(this.value);
		else
			this.callbacks.push(onFulfilled);
	}

	// Resolves once every input has, with their values in order (rejection isn't modeled, matching the
	// rest of this file). `remaining` is a real single-element array, not a plain captured local -- a
	// captured *variable* snapshots by value at each closure's own creation time (mutating it inside one
	// closure is invisible to the others), but mutating an *array element* writes through the shared
	// heap object every one of the `promises.length` closures below alike captured a reference to, so a
	// shared decrementing counter needs this indirection to actually be shared. `i`, only ever read
	// inside its own closure, needs no such trick -- each closure created inside the loop already
	// captures its own per-iteration snapshot of `i` (confirmed via direct execution), same as a real
	// per-iteration `let` binding would.
	static all<U>(promises: Promise<U>[]): Promise<U[]> {
		const values = new Array<U>(promises.length);
		const remaining = new Array<number>(1);
		remaining[0] = promises.length;
		const result = new Promise<U[]>(values);
		if (promises.length === 0) {
			result.resolve(values);
			return result;
		}
		for (let i = 0; i < promises.length; i++) {
			promises[i].then((v: U) => {
				values[i] = v;
				remaining[0] = remaining[0] - 1;
				if (remaining[0] === 0)
					result.resolve(values);
			});
		}
		return result;
	}
}
