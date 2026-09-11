/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	Error -- the shape of a thrown value.
//
//	`throw`/`catch` already worked over any value at all (the payload is a plain
//	`anyref`, and a catch parameter binds as `any`); what was missing was the class
//	itself, so `throw new Error(msg)` -- the overwhelmingly common form, and the only
//	way `lib/node/*` can report a failed host call the way node does -- failed with
//	"'new' is only supported for a known class".
//
//	No `stack`: there is no call-stack introspection in this runtime to build one from,
//	and a field that is always `''` would be worse than its absence.
//-----------------------------------------------------------------------------

class Error {
	name: string = 'Error';

	constructor(public message: string) {}

	toString(): string {
		return this.message.length ? this.name + ': ' + this.message : this.name;
	}
}

// `name` set by the constructor, not redeclared: a subclass may not redeclare an inherited field here.
class RangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RangeError';
	}
}
