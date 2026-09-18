/// <reference path="./lib.d.ts" />

// A symbol is a struct compared by identity, which is all a symbol is: `Symbol('x') !== Symbol('x')`.
export class Symbol {
	readonly description: string | undefined;
	constructor(description?: string) { this.description = description; }
	toString(): string { return 'Symbol(' + (this.description ?? '') + ')'; }
	valueOf(): symbol { return this as unknown as symbol; }
}
