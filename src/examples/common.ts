// `frozen`: TS.Type-context only (this interface is shared with JS.Expr's own literal AST nodes, which never set it) --
// marks a literal produced by an `as`/`as const` assertion, so `type-utils.ts`'s `widenLiterals` leaves it exactly as
// asserted even once it's nested inside a container (an array/object/union) that's itself later widened.
export interface Literal<T> { type: 'literal'; value: T; frozen?: boolean }
export function  Literal<T>(value: T): Literal<T> { return { type: 'literal', value }; }

export interface Identifier {type: 'identifier', name: string}
export function  Identifier(name: string) { return {type: 'identifier', name} as const; }

export interface Unary<E, O>		{ type: 'unary'; operator: O; operand: E };
export function  Unary<E, const O>(operator: O, operand: E): Unary<E, O> { return { type: 'unary', operator, operand}; }
export interface UnaryPost<E, O>	{ type: 'unary_post'; operator: O, operand: E }
export function  UnaryPost<E, const O>(operator: O, operand: E): UnaryPost<E, O> { return { type: 'unary_post', operator, operand}; }

export interface Binary<E, O>       { type: 'binary'; operator: O; left: E; right: E }
export function  Binary<E, const O>(operator: O, left: E, right: E): Binary<E, O> { return { type: 'binary', operator, left, right}; }


export function hasMod(e: {modifiers?: string[]}, m: string) {
    return e.modifiers?.includes(m) ?? false;
}
export function addMod(e: {modifiers?: string[]}, m: string) {
    if (!e.modifiers?.includes(m))
        (e.modifiers ??= []).push(m);
}
export function dropMod(e: {modifiers?: string[]}, m: string) {
    if (e.modifiers?.includes(m))
        e.modifiers = e.modifiers.filter(i => i != m);
}
export function mergeMods(a?: string[], b?: string[]): string[] | undefined {
    if (a || b)
        return [...(a ?? []), ...(b ?? [])];
}

export function  withDefault<T extends {default?: U}, U>(p: T, def: U) { p.default = def; return p; }

// ===================================================================
//  Source location
// ===================================================================
// Non-enumerable so it never shows up in JSON dumps or structural comparisons; `walker.ts`'s
// `mapObject` re-attaches it across a rewrite. Every parser installs `stampPos` as its `makeRule`
// common action, so any shared tool can read `pos` off a node from any language.

export interface Location { line: number, col: number }

export function stampPos<T>(t: T, $: {pos: Location}): T {
	return typeof t === 'object' && t !== null
		? Object.defineProperty(t, 'pos', {value: {line: $.pos.line, col: $.pos.col}, enumerable: false, configurable: true, writable: false })
		: t;
}

export function getPos(node: unknown): Location | undefined {
	return (node as {pos?: Location})?.pos;
}

// ===================================================================
//  Shared expression shapes
// ===================================================================
// The concepts all three parser families have in common, spelled once. Each is generic in its
// expression type `E` (and, where a language needs a richer payload, in that too) so a parser can
// alias or extend it rather than restate it -- the same seam `Unary`/`Binary` above already use.
//
// Naming follows js-parser.ts wherever the shapes already agreed, purely because its consumers
// (checker/towasm/vsdg/transform) are by far the largest body of code reading these fields. Two
// deliberate departures: `Index.index` (js-parser called it `property`, the same name `Member` uses
// for a plain string -- confusing when it holds an expression), and `Sequence.elements` (py-parser
// called it `elts`).

export interface Call<E, A = E>		{ type: 'call'; callee: E; arguments: A[] }
export function  Call<E, A>(callee: E, args: A[]): Call<E, A> { return { type: 'call', callee, arguments: args }; }

// `.`-style access by a fixed name. C's `->` stays a separate `pointer_member` node: it dereferences,
// so it isn't the same operation, only the same syntax shape.
export interface Member<E>			{ type: 'member'; object: E; property: string }
export function  Member<E>(object: E, property: string): Member<E> { return { type: 'member', object, property }; }

export interface Index<E>			{ type: 'index'; object: E; index: E }
export function  Index<E>(object: E, index: E): Index<E> { return { type: 'index', object, index }; }

export interface Conditional<E>		{ type: 'conditional'; test: E; consequent: E; alternate: E }
export function  Conditional<E>(test: E, consequent: E, alternate: E): Conditional<E> { return { type: 'conditional', test, consequent, alternate }; }

// `...x` / `*x` -- JS spread, Python starred, C++ pack expansion.
export interface Spread<E>			{ type: 'spread'; operand: E }
export function  Spread<E>(operand: E): Spread<E> { return { type: 'spread', operand }; }

// A comma/bracket-delimited run of elements. The tag stays per-language (`array`, `list`, `tuple`,
// `set`, `initializer_list` are genuinely different constructors); only the field name is shared, so
// one pass can read the elements of any of them.
export interface Sequence<E, K extends string>	{ type: K; elements: readonly E[] }
export function  Sequence<E, const K extends string>(type: K, elements: readonly E[]): Sequence<E, K> { return { type, elements }; }

// ===================================================================
//  Shared statement shapes
// ===================================================================

export interface ExprStmt<E>		{ type: 'expression'; expression: E }
export function  ExprStmt<E>(expression: E): ExprStmt<E> { return { type: 'expression', expression }; }

export interface Return<E>			{ type: 'return'; argument?: E }
export function  Return<E>(argument?: E): Return<E> { return { type: 'return', argument }; }

// `argument` is optional because Python's bare `raise` re-raises the active exception; js-parser
// narrows it back to required in its own union.
export interface Throw<E>			{ type: 'throw'; argument?: E }
export function  Throw<E>(argument?: E): Throw<E> { return { type: 'throw', argument }; }
