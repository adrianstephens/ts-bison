
export function  withDefault<T extends {default?: U}, U>(p: T, def: U) { p.default = def; return p; }

// ===================================================================
//  modifiers
// ===================================================================

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
// Each is generic in its expression type `E` (and, where a language needs a richer payload, in that too)

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

export interface Call<E, A = E>		{ type: 'call'; callee: E; arguments: A[] }
export function  Call<E, A>(callee: E, args: A[]): Call<E, A> { return { type: 'call', callee, arguments: args }; }

// `.`-style access by a fixed name. C's `->` stays a separate `pointer_member` node: it dereferences, so it isn't the same operation, only the same syntax shape.
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

// Assignment is a MUTATION, not a computation. js-parser used to spell it as a `Binary` whose
// operator happened to end in `=`, so every consumer re-derived "is this an assignment" from the
// operator string -- towasm, vsdg and tocode each kept their own copy of that knowledge, the copies
// disagreed with the grammar, and vsdg silently dropped `x &&= y` as a result. The tag carries it now.
//
// `operator` absent is a plain `=`; present it is the compound form's BASE operator (`+=` -> `+`),
// stored rather than recovered by slicing the `=` off a string. Python's assign/augassign split
// collapses onto the same node.
export interface Assign<E, O>		{ type: 'assign'; operator?: O; target: E; value: E }
export function  Assign<E, const O>(target: E, value: E, operator?: O): Assign<E, O> { return { type: 'assign', operator, target, value }; }

// Suspension points, not computations. js-parser used to fold `await` into `Unary` purely because it
// has the same prefix syntax as `typeof`/`void` -- and then checker, transform, vsdg and ts2py each
// had to peel it back out before their unary handling. `yield` was already its own node here; these
// two are the same kind of thing and now say so. CPython's AST and ESTree both split them likewise.
export interface Await<E>			{ type: 'await'; operand: E }
export function  Await<E>(operand: E): Await<E> { return { type: 'await', operand }; }

// `delegate` (`yield*`) / `from` (`yield from`) are each language's own addition.
export interface Yield<E>			{ type: 'yield'; operand?: E }
export function  Yield<E>(operand?: E): Yield<E> { return { type: 'yield', operand }; }

export interface ExprStmt<E>		{ type: 'expression'; expression: E }
export function  ExprStmt<E>(expression: E): ExprStmt<E> { return { type: 'expression', expression }; }

export interface Return<E>			{ type: 'return'; argument?: E }
export function  Return<E>(argument?: E): Return<E> { return { type: 'return', argument }; }

// `argument` is optional because Python's bare `raise` re-raises the active exception; js-parser
// narrows it back to required in its own union.
export interface Throw<E>			{ type: 'throw'; argument?: E }
export function  Throw<E>(argument?: E): Throw<E> { return { type: 'throw', argument }; }

// The braced statement group. js-parser and c-parser both have one; py-parser doesn't (its slots are
// already arrays). Generic in the statement type rather than in a dialect's type-annotation type, so
// a pass holding a WIDER statement union than the parser's own can still build one.
export interface Block<S>			{ type: 'block'; body: S[] }
export function  Block<S>(...body: S[]): Block<S> { return { type: 'block', body }; }

// The control-flow statements. `B` is the BODY slot -- one statement in js-parser and c-parser (a `Block` when the source delimited it), a statement list in py-parser.
// The languages genuinely differ there, so it stays a type parameter rather than being forced into one representation;
export interface If<E, B>			{ type: 'if'; test: E; consequent: B; alternate?: B }
export function	If<E, B>(test: E, consequent: B, alternate?: B): If<E, B> { return { type: 'if', test, consequent, alternate }; }
export interface While<E, B>		{ type: 'while'; test: E; body: B }
export function While<E, B>(test: E, body: B): While<E, B> { return { type: 'while', test, body }; }
export interface DoWhile<E, B>		{ type: 'do_while'; body: B; test: E }
export function DoWhile<E, B>(body: B, test: E): DoWhile<E, B> { return { type: 'do_while', body, test }; }
export interface Labeled<B>			{ type: 'labeled'; label: string; body: B }

// A `catch` / `except` clause. `param` is whatever the language binds (a JS binding target, a Python or C++ name); each parser intersects its own extras onto it
// -- an exception `type`, a Python `except*` star, a C++ by-reference flag.
export interface Handler<S, P = unknown>	{ param?: P; body: S[] }
export interface Try<S, P = unknown>		{ type: 'try'; body: S[]; handlers: Handler<S, P>[]; finalizer?: S[] }

// ===================================================================
//  Body access
// ===================================================================
// A statement slot holds different things in different languages: js-parser and c-parser put ONE
// statement there (a `block` when the source braced it), py-parser an array. These read and write it
// uniformly, so a pass spanning all three doesn't need the representations themselves to match.

function isArray<S>(x: S | readonly S[]): x is readonly S[] { return Array.isArray(x); }

export function bodyOf<S extends {type: string}>(slot: S | readonly S[] | undefined): readonly S[] {
	if (!slot)
		return [];
	if (isArray(slot))
		return slot;
	const block = slot as S & {body?: readonly S[]};
	return block.type === 'block' && block.body ? block.body : [slot];
}

// Writes a rewritten body back into a single-statement slot. Wrapping in a block is the SAFE default
// and the reason this exists: a bare slot can't legally hold a declaration (`if (x) let y = 1;` isn't
// valid JS), so a pass that inserts one must produce a block. A caller that knows its own language's
// declaration tags can pass `canBeBare` to keep the un-braced form where that's still correct.
export function withBody<S extends {type: string}>(stmts: readonly S[], block: (body: readonly S[]) => S, canBeBare?: (stmt: S) => boolean): S {
	return stmts.length === 1 && canBeBare?.(stmts[0]) ? stmts[0] : block(stmts);
}
