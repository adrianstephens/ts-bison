// ===================================================================
//  The TypeScript/JavaScript half of the language-neutral VSDG.
// ===================================================================
// This is the old monolithic TS/vsdg.ts, split by language: everything language-neutral moved to
// ../vsdg.ts and everything TypeScript-shaped stayed here. Three pieces:
//
//   * `TSDialect`   -- how to walk this AST, and the few shape facts the core asks about;
//   * `TSBuilder`   -- lowering: this AST's statement/expression tags onto graph nodes;
//   * `TSEmitter`   -- reconstruction: graph nodes back onto this AST (JS/printer.ts prints it).
//
// plus, at the bottom, the pipeline entry points this language exposes:
//
//     BuildVSDG(ast) -> Optimize(graph) -> applyGlobalCodeMotion(graph) -> BuildProgram(graph, ...)
//
// Everything they call (`makeNode`/`connectValue`/`rebindVar`/`bindVar`/`buildLoop`/`walkBranch`/`mergeState`/
// `reconcileVariables`/`buildFunctionBody`/`emitChain`/`resolveOperand`/...) is the core's.

import * as JS from './js-parser';
import * as TS from './ts-parser';
import { Identifier, Literal, Unary, Binary, Assign, If, ExprStmt, Block } from '../common';
import { walkerB as makeWalkerB, calcUnary, calcBinary, isJsStatement, isTsDeclaration } from './walker';
import { patternBindings as buildPatternBindings } from './transform';
import { tocode } from './type-utils';
import {
	Dialect, VSDGBuilder, Emitter, Recurse, ParamSlot, NodeType, SwitchSyntax,
	Node, NodeOf, NodeId, ClassInfo, ClassMember, SwitchCase, Scope, VSDG, BlockTree,
	connectValue, slotName,
	optimize, optimizeStructuralCSE as structuralCSE,
} from '../vsdg';

type Expr	= TS.Expr;
type Stmt	= TS.Stmt;
type Type	= TS.Type;
type N		= Node<Expr, Stmt, Type>;
type NOf<K extends NodeType> = NodeOf<Expr, Stmt, Type, K>;

// ===================================================================
//  Dialect
// ===================================================================

const tsDialect: Dialect<Expr, Stmt, Type> = {
	identifierName(e) {
		return e.type === 'identifier' ? e.name : undefined;
	},
	identifier(name) {
		return Identifier(name);
	},
	literal(value) {
		return Literal(value as never);
	},
	// Only the literal `true` -- a while-loop's condition resolving to one is a real `for(;;)` (or a
	// for-in desugar), where the rotation check is provably dead.
	isTrueLiteral(e) {
		return e.type === 'literal' && e.value === true;
	},
	// A 'floating' node's real discriminator is its own expr's type, except for these three, whose
	// OPERATOR is what separates `a + b` from `a - b` (cheaper than printing either).
	exprKey(e) {
		switch (e.type) {
			case 'assign':
			case 'binary':
			case 'unary':	return String((e as {operator?: unknown}).operator);
		}
		return tocode.expression(e);
	},
	stmtKey(s) {
		return tocode.statement(s);
	},
	isCSEUnsafe(node) {
		// 'this'/'super': identical structural key regardless of which method they're in, but each
		// one's real value is bound per call, so merging them conflates two different receivers.
		// 'array'/'object' get a fresh identity per evaluation in real JS, unlike a true literal.
		// 'member'/'index' reads can observe an intervening mutation between two textually-identical
		// occurrences.
		return node.type === 'floating' && ['array', 'object', 'index', 'this', 'super'].includes(node.expr.type);
	},
	foldable(node) {
		return node.type !== 'floating'
			? 0
			: node.expr.type === 'binary' ? 2 : node.expr.type === 'unary' ? 1 : 0;
	},
	foldValue(node, ops) {
		if (node.type !== 'floating')
			return undefined;
		return	node.expr.type === 'binary'	? calcBinary(node.expr.operator, ops[0], ops[1])
			:	node.expr.type === 'unary'	? calcUnary(node.expr.operator, ops[0])
			:	undefined;
	},
	// A literal's value is its own `value` field; nothing else in this AST is a constant.
	literalValue(e) {
		return e.type === 'literal' ? e.value : undefined;
	},
	// js/ts falsiness of a constant -- the value here IS the runtime value, so `!!` is exactly it.
	truthy(value) {
		return !!value;
	},
	isCalleeEdge(consumer, port) {
		const v = consumer.type === 'effect' && consumer.expr;
		if (!v || (v.type !== 'call' && v.type !== 'new'))
			return false;
		return port === v.arguments.length + 1;
	}
};

// ===================================================================
//  Lowering
// ===================================================================

// Flattens this language's own parameter list into the core's neutral slots. A plain name gets its
// own param node; a destructured one gets a hidden temp, plus the step that binds its names off that
// temp -- a closure here rather than a `Dialect` question, because finishing a pattern is LOWERING:
// it walks statements (see ParamSlot's own comment).
function paramSlots(params: JS.Params<Type> | undefined, recurse: Recurse<Expr, Stmt>): ParamSlot[] | undefined {
	// Only `key` is read: a plain parameter and the trailing rest differ elsewhere, and on both a key
	// is either a name or a destructuring pattern.
	const slot = (p: { key: string | JS.BindingTarget }): ParamSlot => {
		const key = p.key;
		return typeof key === 'string' ? { name: key }
			: { token: key, desugar: tempName => {
				for (const stmt of patternBindings('let', key, Identifier(tempName)))
					recurse.statement(stmt);
			} };
	};
	if (!params)
		return undefined;
	const slots: ParamSlot[] = params.params.map(slot);
	if (params.rest)
		slots.push(slot(params.rest));
	return slots;
}

export class TSBuilder extends VSDGBuilder<Expr, Stmt, Type> implements SwitchSyntax<Expr, Stmt, Type> {
	constructor() { super(tsDialect); }

	build(ast: readonly Stmt[]) {
		makeWalkerB(
			(s, process, recurse) => this.lowerStatement(s, process, recurse),
			(e, process, recurse) => this.lowerExpression(e, process, recurse)
		).statements(ast);
	}

	// ---- SwitchSyntax: js/ts's own spelling of switch's fixed scaffolding (the walk is the core's) ----

	local(value: Expr, name: string) {
		const node = this.makeNode({ type: 'var', name, declKind: 'let' });
		connectValue(this.getExprNode(value), 0, node, 0);
		return node;
	}
	comparison(discName: string, test: Expr): Expr {
		return { type: 'binary', operator: '===', left: Identifier(discName), right: test } as Expr;
	}
	// `default` matches iff none of the OTHER cases did, wherever it sits.
	condition(hitName: string, matchName: string | undefined, otherMatches: string[]): Expr {
		const hit	= Identifier(hitName);
		const others: Expr = otherMatches.length === 0
			? Literal(true)
			: { type: 'unary', operator: '!', operand: otherMatches.map((n): Expr => Identifier(n)).reduce((a, b) => Binary('||', a, b) as Expr) } as Expr;
		return { type: 'binary', operator: '||', left: hit, right: matchName !== undefined ? Identifier(matchName) : others } as Expr;
	}
	setHit(hitName: string): Expr {
		return Assign<Expr, JS.assignableOps>(Identifier(hitName), Literal(true));
	}

	lowerStatement(s: Stmt, process: (s: Stmt) => boolean, recurse: Recurse<Expr, Stmt>): boolean {
		switch (s.type) {
			case 'function_decl':
				if (s.body) {
					const fn = this.buildFunctionBody(recurse, paramSlots(s, recurse), s.body);
					fn.stmt = s;
					this.end = fn;
				}
				return false;

			case 'return': {
				// The marker carries its value directly at port 1 (unconnected for bare `return;`)
				// rather than through scope -- scope can't represent "hasn't returned yet, keep
				// going". `exited = true` makes 'if' build a real gamma around this path instead, so
				// each return prints itself, in place, with no value-merge needed here at all.
				if (s.argument)
					recurse.expression(s.argument);
				const marker = this.makeMarker('EARLY_RETURN_MARKER');
				this.connectEnd(marker);
				if (s.argument)
					connectValue(this.getExprNode(s.argument), 0, marker, 1);
				this.exited = true;
				return false;
			}
			case 'throw': {
				// Only an EXPLICIT throw is modeled -- a call inside `try` that might itself throw
				// isn't a control-flow edge to `catch`; real JS's own exception routing handles
				// that at runtime regardless, since nothing here reorders the try body's statements.
				recurse.expression(s.argument);
				const marker = this.makeMarker('THROW_MARKER');
				this.connectEnd(marker);
				connectValue(this.getExprNode(s.argument), 0, marker, 1);
				this.exited = true;
				return false;
			}
			case 'break': {
				// A labeled break can target an OUTER loop/switch, not just the nearest enclosing
				// one -- not supported here (no label-aware target tracking exists), so flag it
				// rather than silently mistargeting.
				if (s.label)
					console.log(`not handling labeled break`);
				// No target-tracking needed: just mark `exited` (so enclosing `if`s treat this
				// branch as not falling through) and leave a marker for the literal `break;` to
				// print here -- real JS routes it to the nearest enclosing loop/switch at runtime.
				this.connectEnd(this.makeMarker('BREAK_MARKER'));
				this.exited = true;
				this.brokeOut = true;
				return false;
			}
			case 'continue': {
				if (s.label)
					console.log(`not handling labeled continue`);
				// A real `for` loop's `update` still runs on `continue` -- but this is lowered onto
				// the same while-shaped graph `while` uses, where a bare `continue;` would otherwise
				// skip it. Re-walks a FRESH clone of `update` first (switch pushes nothing onto
				// loopUpdateStack, so it's correctly transparent to a `continue` inside a case).
				const forUpdate = this.loopUpdateStack[this.loopUpdateStack.length - 1];
				if (forUpdate)
					recurse.expression(structuredClone(forUpdate));
				this.connectEnd(this.makeMarker('CONTINUE_MARKER'));
				this.exited = true;
				return false;
			}
			case 'var_decl': {
				// Each declarator's initializer is walked THEN immediately bound, one at a time --
				// not all-then-all -- since real declarators in one statement bind strictly left to
				// right (`let i = off, e = i + len;` needs `i` already in scope for `e`'s own read).
				for (const v of s.declarations) {
					if (typeof v.name === 'string') {
						if (v.init)
							recurse.expression(v.init);
						// A dedicated wrapper node per declared variable, not an alias to the
						// initializer's own node -- otherwise `let x = 5; let y = 5;` would bind both
						// names to the same node, with no way to tell which name to print.
						const varNode = this.makeNode({type: 'var', name: v.name});
						if (v.init)
							connectValue(this.getExprNode(v.init), 0, varNode, 0);
						varNode.declKind = s.kind;
						varNode.typeAnnotation = v.typeAnnotation;
						// A declaration is an observable event too, like a reassignment: without this,
						// GCM could schedule `let a = 1;` after code that already reads `a`, since both
						// look like ordinary data to the scheduler otherwise.
						this.bindVar(varNode);
					} else if (v.init) {
						// Bind the real initializer to a hidden temp exactly once (patternBindings may
						// read it multiple times, so it must never see an effectful expression
						// directly), then desugar the pattern off that temp -- a nested pattern is
						// handled for free by re-entering this same case for each flattened result.
						const tempName = `__destructure${this.freshId()}`;
						recurse.statement(JS.VarDecl<Type>(s.kind, JS.Var<Type>(tempName, v.init)) as Stmt);
						for (const stmt of patternBindings(s.kind, v.name, Identifier(tempName)))
							recurse.statement(stmt);
					} else {
						console.log(`not handling destructured declarator with no initializer`);
					}
				}
				return false;
			}

			case 'block': {
				this.scope = new Scope(this.scope);
				process(s);
				this.scope = this.scope.closeAndFlush()!;
				return false;
			}
			case 'if': {
				recurse.expression(s.test);
				const test		= this.getExprNode(s.test);
				const parent	= this.getState();
				// `recurse`, not `process`: a bare, non-block consequent (`if (x) let y = 1;`) still
				// needs its own var_decl/if/while dispatch, which `process` alone wouldn't give it.
				const trueState		= this.walkBranch(parent, () => recurse.statement(s.consequent));
				const falseState	= this.walkBranch(parent, () => { if (s.alternate) recurse.statement(s.alternate!); });
				this.mergeState(parent, test, trueState, falseState);
				this.reconcileVariables(parent, test, trueState, falseState);
				return false;
			}

			case 'while':
				this.buildLoop(recurse, s.test, () => recurse.statement(s.body), false);
				return false;

			case 'do_while':
				// The body runs BEFORE the test (using the mu's INITIAL value on the first pass), unlike `while`
				this.buildLoop(recurse, s.test, () => recurse.statement(s.body), true);
				return false;

			case 'for': {
				// `for await...of` needs the async iterator protocol -- `await` has no dedicated
				// case anywhere in this file, so it stays verbatim rather than silently dropping the
				// loop and running its body once.
				if (s.kind === 'of await') {
					console.log(`not handling for-${s.kind}`);
					return this.lowerVerbatim(s, process);
				}
				if (s.kind !== 'normal') {
					// Desugars to the real synchronous iterator protocol, reusing buildLoop's
					// existing while-shaped machinery: `const __iterN = iterable[Symbol.iterator]();
					// while (true) { const __rN = __iterN.next(); if (__rN.done) break; binding =
					// __rN.value; body }`. `for...in` reuses the same shape over `Object.keys(iterable)`
					// (own enumerable keys only, not the full prototype-chain walk). No `forUpdate`:
					// an ordinary `continue` already re-runs the advance, same as real for-of.
					const suffix		= String(this.freshId());
					const iterName		= `__iter${suffix}`;
					const resultName	= `__r${suffix}`;
					const iterable		= s.kind === 'in' ? JS.Call<Type>(JS.Member<Type>(Identifier('Object'), 'keys'), [s.right]) : s.right;
					recurse.statement(JS.VarDecl<Type>('const', JS.Var<Type>(iterName,
						JS.Call<Type>(JS.Index<Type>(iterable, JS.Member<Type>(Identifier('Symbol'), 'iterator')), [])
					)));

					const value = JS.Member<Type>(Identifier(resultName), 'value');
					this.buildLoop(recurse, Literal(true), () => recurse.statement(JS.Block<Stmt>(
						JS.VarDecl<Type>('const', JS.Var<Type>(resultName, JS.Call<Type>(JS.Member<Type>(Identifier(iterName), 'next'), []))),
						If(JS.Member<Type>(Identifier(resultName), 'done'), { type: 'break' }),
						(s.init.type === 'var_decl'
							? JS.VarDecl<Type>(s.init.kind, JS.Var<Type>(s.init.declarations[0].name, value))
							: ExprStmt(Assign<Expr, JS.assignableOps>(s.init, value))),
						s.body
					)), false);
					return false;
				}
				// Run init once, before the loop, then desugar to `while (test) { body; update; }`,
				// folding `update` into the body's own normal (non-continue) tail.
				if (s.init) {
					if (s.init.type === 'var_decl')
						recurse.statement(s.init);
					else
						recurse.expression(s.init);
				}
				const test = s.test ?? Literal(true);
				const body = s.update ? JS.Block(s.body, ExprStmt(s.update)) : s.body;
				this.buildLoop(recurse, test, () => recurse.statement(body), false, s.update);
				return false;
			}

			case 'switch': {
				// The cascade itself is the core's (`buildSwitch`); what follows is js/ts's spelling of the
				// scaffolding it asks for. Note `continue` inside a case is routed past the switch to the
				// enclosing loop, and an empty switch's own break_scope reconstructs to nothing.
				this.buildSwitch(recurse, s.discriminant, s.cases.map(c => ({
					test: c.test,
					body: () => { for (const stmt of c.consequent) recurse.statement(stmt); },
				})), this);
				return false;
			}
			case 'try': {
				// A bare `try { } finally { }` (no catch) isn't attempted here -- there's no
				// value to merge in that shape (nothing diverges, since only one path exists),
				// which is a genuinely different, simpler case this doesn't cover yet.
				const handler = s.handlers[0];
				if (!handler) {
					console.log(`not handling try without catch`);
					return this.lowerVerbatim(s, process);
				}
				const parent = this.getState();

				// Each branch gets its own dedicated start marker between the shared predecessor
				// and its own walk -- without one, a branch's own first statement needing a real
				// gamma/mu/break_scope/except would share the exact same predecessor as `except`.
				const startMarker = (pred: N, tag: 'TRY_START' | 'CATCH_START' | 'FINALLY_START') => {
					const marker = this.makeMarker(tag);
					connectValue(pred, 0, marker, 0);
					return marker;
				};

				// Each branch gets TWO nested scopes: an outer one the reconciliation loop reads
				// (matching if/else), and an inner one closeAndFlush()'d first so a `let`/const
				// declared directly in the block/handler body doesn't leak into the outer bindings.
				this.setState(new Scope(parent.scope), startMarker(parent.end, 'TRY_START'));

				this.scope = new Scope(this.scope);
				for (const stmt of s.body)
					recurse.statement(stmt);
				this.scope = this.scope.closeAndFlush()!;
				const tryState		= this.getState();

				this.setState(new Scope(parent.scope), startMarker(parent.end, 'CATCH_START'));
				this.scope = new Scope(this.scope);
				// For a destructured catch param, catchParamName is the hidden temp that actually
				// prints in `catch (<here>)`, with the real pattern desugared right after.
				let catchParamName: string | undefined;
				if (typeof handler.param === 'string') {
					catchParamName = handler.param;
					this.scope.create(catchParamName, this.makeNode({type: 'var', name: catchParamName}));
				} else if (handler.param) {
					catchParamName = `__destructure${this.freshId()}`;
					this.scope.create(catchParamName, this.makeNode({type: 'var', name: catchParamName}));
					for (const stmt of patternBindings('let', handler.param, Identifier(catchParamName)))
						recurse.statement(stmt);
				}
				for (const stmt of handler.body)
					recurse.statement(stmt);
				this.scope = this.scope.closeAndFlush()!;
				const catchState	= this.getState();

				// Unlike an `if`'s gamma, this is never skipped even with no real effect in either
				// branch -- try/catch is observable syntax in its own right, so it always needs a
				// real anchor to reconstruct from.
				const exc = this.makeNode({ type: 'except' });
				if (catchParamName !== undefined)
					exc.catchParam = catchParamName;
				connectValue(parent.end, 0, exc, 0);
				connectValue(tryState.end, 0, exc, 1);
				connectValue(catchState.end, 0, exc, 2);
				this.end = exc;

				// Per-variable merges -- mirrors 'if', except neither branch's binding is ever
				// cleared: there's no printable condition for a ternary, so each branch keeps (and
				// force-prints) its own `x = ...;` under its own name, and the merge just connects
				// both as real dependencies.
				this.scope = parent.scope;
				const diverged = new Set([...tryState.scope.bindings.keys(), ...catchState.scope.bindings.keys()]);
				for (const name of diverged) {
					const tryVal	= tryState.scope.get(name)!;
					const catchVal	= catchState.scope.get(name)!;
					if (tryVal !== catchVal) {
						if (slotName(tryVal) === name)
							tryVal.forcedPrint = true;
						if (slotName(catchVal) === name)
							catchVal.forcedPrint = true;

						const namedExc = this.makeNode({ type: 'exceptValue', name });
						connectValue(tryVal, 0, namedExc, 0);
						connectValue(catchVal, 0, namedExc, 1);
						this.scope.set(name, namedExc);
					}
				}

				// `finally` runs after the merge, walked like ordinary code (not modeled at the
				// graph level as "runs on every exit path" -- reconstructed as a real `finally`
				// clause, real JS semantics already guarantee that on their own).
				let finallyExited = false;
				let finallyBrokeOut = false;
				if (s.finalizer) {
					this.end		= startMarker(exc, 'FINALLY_START');
					this.exited		= false;
					this.brokeOut	= false;
					// Same reasoning as try/catch's own inner scope: a `let`/const in the finalizer
					// shouldn't leak out, but an ordinary reassignment should still propagate.
					this.scope		= new Scope(this.scope);
					for (const stmt of s.finalizer)
						recurse.statement(stmt);
					this.scope			= this.scope.closeAndFlush()!;
					finallyExited		= this.exited;
					finallyBrokeOut		= this.brokeOut;
					// Port 3 = finally's own tail, mirroring a gamma's true/false-tail ports.
					connectValue(this.end, 0, exc, 3);
					this.end = exc;
				}
				// A return/throw/break/continue inside `finally` itself overrides try/catch, so
				// the WHOLE construct only falls through when finally (if present) does too.
				this.exited = finallyExited || (tryState.exited && catchState.exited);
				this.brokeOut = s.finalizer
					? finallyBrokeOut
					: (tryState.exited && catchState.exited && tryState.brokeOut && catchState.brokeOut);
				return false;
			}
			case 'expression':
				// A bare literal statement is a directive (`"use strict"`), not dead arithmetic.
				if (s.expression.type === 'literal')
					return this.lowerVerbatim(s, process);
				break;

			case 'export_decl': {
				// `export class Foo {...}`/`export function f() {...}`/`export const x = 1;` --
				// recursing here (rather than falling to `default:`, whose generic descent ALSO
				// walks s.declaration independently) runs the declaration's own handler exactly
				// once, avoiding a literal duplicate; `exported` is read back at that node's own
				// print site to wrap it in `export `.
				recurse.statement(s.declaration);
				if (s.declaration.type === 'var_decl') {
					// `end` here is a MUTATION_MARKER wrapping only the LAST declarator's rebind --
					// wrong for `export const a = 1, b = 2;` (every declarator needs the flag), so
					// each declared name's real node is looked up directly from scope instead.
					for (const v of s.declaration.declarations)
						if (typeof v.name === 'string')
							this.scope.get(v.name)!.exported = 'named';
				} else {
					this.end.exported = 'named';
				}
				return false;
			}

			case 'import': {
				// Each bound name (namespace/default/named specifiers) gets its own declKind-less,
				// never-bound 'var' node (same shape externalNodes uses, so it never gets its
				// own declaration statement -- the import's own passthru node declares it) with a
				// threadMutation anchor right after that passthru, so GCM can never place a read
				// earlier than the import that provides it. A type-only import binds no real
				// runtime value, so it's skipped.
				this.lowerVerbatim(s, process);
				if (!s.typeOnly) {
					const bindImport = (name: string) => {
						const varNode = this.makeNode({type: 'var', name});
						this.threadMutation(varNode);
						this.scope.create(name, varNode);
					};
					if (s.namespace)
						bindImport(s.namespace);
					if (s.default)
						bindImport(s.default);
					for (const spec of s.specifiers ?? [])
						if (!spec.typeOnly)
							bindImport(spec.local);
				}
				return false;
			}

			case 'export': {
				// `export default class Foo {...}`/`function f() {...}` -- same double-processing
				// risk and fix as export_decl above. A plain-expression default, or a re-export
				// with no `default` (referencing only already-declared bindings by name), needs no
				// VSDG resolution, so it prints verbatim.
				if (s.default !== undefined && (isJsStatement(s.default) || isTsDeclaration(s.default))) {
					recurse.statement(s.default);
					this.end.exported = 'default';
					return false;
				}
				this.lowerVerbatim(s, process);
				return false;
			}

			case 'class_decl': {
				// Its own dedicated type tag (not a bare 'passthru', which would need a runtime
				// value-shape check to tell "resolved class" from "verbatim") makes "always needs
				// rebuildClass" a property of the node itself. Anchored as a statement, not an
				// 'effect' ('class' the expression uses that), since it produces no value.
				const node = this.makeNode({type: 'class_decl', stmt: s});
				node.classInfo = this.buildClass(recurse, node, s);
				this.connectEnd(node);
				return false;
			}

			default:
				// Anything this dialect doesn't model (`labeled`, `with`, `debugger`, an ambient
				// declaration, ...) prints verbatim; an unreferenced declaration is otherwise an
				// unanchored island nothing schedules.
				this.lowerVerbatim(s, process);
				return false;
		}
		return process(s);
	}

	lowerExpression(s: Expr, process: (e: Expr) => boolean, recurse: Recurse<Expr, Stmt>): boolean {
		switch (s.type) {
			case 'literal': {
				// No dedicated tag: a literal is just a 'floating' node whose own expr is this AST's
				// literal form -- which is what the dialect's `literalValue` reads back out, and what
				// foldConstants folds a binary/unary into in place (same shape, no rewiring).
				this.makeExprNode(s);
				return false;
			}

			case 'identifier':
				return false;

			case 'super':
			case 'this': {
				// Unlike 'identifier', `this`/`super` have no scope lookup -- they need a real node registered here, or any consumer throws "missing node" looking one up.
				// See scopeAnchorId's own comment -- without this, a this-derived value GCM forces to materialize has nothing to floor it, escaping its own function/class.
				this.makeExprNode(s).scopeAnchorId = this.currentFunctionEntry?.id;
				return false;
			}

			// Not pure: it suspends. Same treatment as 'yield'.
			case 'await': {
				process(s);
				const node = this.makeExprNode(s, 'effect');
				this.connectEnd(node);
				connectValue(this.getExprNode(s.operand), 0, node, 1);
				return false;
			}

			case 'unary': {
				process(s);
				const isMutation = s.operator === '++' || s.operator === '--';
				const node = this.makeExprNode(s, isMutation ? 'mutation' : 'floating');
				connectValue(this.getExprNode(s.operand), 0, node, 0);
				if (isMutation) {
					if (s.operand.type === 'identifier') {
						this.rebindVar(s.operand.name, node);
					} else {
						// A property/index target mutates something outside this pass's own scope tracking -- same reasoning as unary_post's own non-identifier branch below:
						// nothing reads this back through scope, so needsTemp would drop it entirely.
						node.forcedPrint = true;
						this.threadMutation(node);
					}
				}
				return false;
			}
			case 'unary_post': {
				// The non-null assertion (`expr!`) shares the `unary_post` AST shape with a real mutating postfix `++`/`--`, but has no runtime effect at all
				// -- alias straight through, no new node, no old-value snapshot, no rebind.
				if (s.operator === '!') {
					process(s);
					this.expnodes.set(s, this.getExprNode(s.operand));
					return false;
				}
				// Unlike prefix, `i++`/`i--` evaluates to the OLD value -- can't alias to the operand's
				// own node, since that stays reachable by name after the rebind and would silently
				// pick up the NEW value. A dedicated snapshot node, threaded before the rebind, pins
				// both its identity and schedule position to this exact moment.
				process(s);
				const operandNode	= this.getExprNode(s.operand);
				const oldNode		= this.makeExprNode(s, 'unary_post_old' as 'floating');
				connectValue(operandNode, 0, oldNode, 0);
				this.threadMutation(oldNode);

				const node = this.makeNode({ type: 'unary_post', expr: s });
				connectValue(operandNode, 0, node, 0);
				// Scheduling-only (see the core's own INVARIANT): the snapshot must be READ before the
				// increment runs, and the mutation marker alone only floors it -- nothing stops GCM
				// sinking the snapshot down to its consumer, past the increment, turning `g(i++)` into
				// `g(<new i>)`. Making the increment a consumer pins the snapshot above it.
				connectValue(oldNode, 0, node, 1);
				if (s.operand.type === 'identifier') {
					this.rebindVar(s.operand.name, node);
				} else {
					// A property/index target mutates something outside this pass's own scope
					// tracking, with no name to rebind -- oldNode's own "materialize only if read"
					// rule covers the snapshot, but says nothing about the mutation ITSELF still
					// needing to run, so it gets its own forced anchor too.
					node.forcedPrint = true;
					this.threadMutation(node);
				}
				return false;
			}
			// Always a mutation -- no operator set to consult, and none to forget an entry from.
			case 'assign': {
				process(s);
				const node = this.makeExprNode(s, 'mutation');
				// A plain `=` (no compound operator) never reads its own "old value" port.
				node.plainAssign = s.operator === undefined;
				connectValue(this.getExprNode(s.target), 0, node, 0);
				connectValue(this.getExprNode(s.value), 0, node, 1);
				if (s.target.type === 'identifier') {
					// Reassigning a variable CAPTURED from an enclosing function is an effect
					// that escapes this function -- its real consumer may be a not-yet-run
					// caller, so a same-region consumer count can't decide it's dead/inlinable.
					if (!this.scope.isLocalToCurrentFunction(s.target.name))
						node.forcedPrint = true;
					this.rebindVar(s.target.name, node);
				} else {
					// A property/index assignment mutates something outside this pass's scope
					// tracking -- threadMutation anchors it (no name to bind); forcedPrint keeps
					// it printing regardless of consumer count, since nothing reads it back
					// through scope the way a bound variable would.
					node.forcedPrint = true;
					this.threadMutation(node);
				}
				return false;
			}

			// Never a mutation now that assignment has its own tag.
			case 'binary': {
				process(s);
				const node = this.makeExprNode(s, 'floating');
				connectValue(this.getExprNode(s.left), 0, node, 0);
				connectValue(this.getExprNode(s.right), 0, node, 1);
				return false;
			}
			case 'call': {
				// 1. Thread the State Edge to preserve sequence
				process(s);
				// TEMPORARY placeholder for real purity analysis: a callee name starting with
				// "pure" is treated as pure for testing, nothing to do with actual purity.
				const pure = s.callee.type === 'identifier' && s.callee.name.startsWith('pure');
				const node = pure ? this.makeExprNode(s) : this.makeExprNode(s, 'effect');
				if (!pure)
					this.connectEnd(node); // Slot 0 = Input State

				// 2. Thread Value Edges for the function arguments
				s.arguments.forEach((arg, index) => connectValue(this.getExprNode(arg), 0, node, index + 1));

				// The callee prints verbatim, unresolved -- but a bare identifier callee still needs
				// a real graph edge, purely so hasRealConsumer sees it: without one, `const g =
				// makeThing(); g();` looks like `g` is never read, and gets dropped as dead.
				connectValue(this.getExprNode(s.callee), 0, node, s.arguments.length + 1);
				return false;
			}

			case 'new': {
				// Always treated as an effect, like an impure call -- a constructor can run
				// arbitrary code, so there's no equivalent of `call`'s "pureFoo" opt-in here.
				process(s);
				const node = this.makeExprNode(s, 'effect');
				this.connectEnd(node);
				s.arguments.forEach((arg, index) => connectValue(this.getExprNode(arg), 0, node, index + 1));
				// See 'call' above for why the callee still needs a real edge despite never being resolved as a value.
				connectValue(this.getExprNode(s.callee), 0, node, s.arguments.length + 1);
				return false;
			}
			case 'yield': {
				// Treated as an effect, like an impure call -- the only thing that matters here is that a yield never gets reordered relative to other effects
				process(s);
				const node = this.makeExprNode(s, 'effect');
				this.connectEnd(node);
				if (s.operand)
					connectValue(this.getExprNode(s.operand), 0, node, 1);
				return false;
			}
			case 'tagged_template': {
				// Desugars to calling `tag` with a strings array plus each interpolated expression --
				// effectful like an ordinary impure call. Only the interpolated `.exp`s need threading; the literal string parts carry through in node.expr unchanged.
				process(s);
				const node = this.makeExprNode(s, 'effect');
				this.connectEnd(node);
				s.quasi.forEach((part, index) => {
					if (part.exp)
						connectValue(this.getExprNode(part.exp), 0, node, index + 1);
				});
				return false;
			}
			case 'class': {
				// A class expression's own definition can run arbitrary code (a computed key, or the heritage clause, can call out) -- always order-anchored, like 'new'
				const node = this.makeExprNode(s, 'effect');
				node.classInfo = this.buildClass(recurse, node, s);
				this.connectEnd(node);
				return false;
			}
			case 'jsx': {
				// Desugars to a factory call at runtime -- effectful for the same reason 'call' is.
				// `name` and each attribute's own key are compile-time metadata, unchanged.
				process(s);
				const node = this.makeExprNode(s, 'effect');
				this.connectEnd(node);
				let port = 1;
				s.attributes.forEach(attr => {
					if (attr.value)
						connectValue(this.getExprNode(attr.value), 0, node, port++);
				});
				s.children.forEach(child => connectValue(this.getExprNode(child), 0, node, port++));
				return false;
			}
			case 'arrow':
			case 'function': {
				if (!s.body)
					return false;
				// Same 'function' entry a declaration gets, but with `.expr` set -- marks it a
				// printable value (prints `.expr` verbatim, GCM never moves function bodies).
				// expnodes.set lets a later getExprNode(s) find this node.
				const entry = this.buildFunctionBody(recurse, paramSlots(s, recurse), s.body);
				entry.expr = s;
				this.expnodes.set(s, entry);
				this.end = entry;
				return false;
			}
			case 'member': {
				process(s);
				const node = this.makeNode({type: 'member', name: s.property});
				node.optional = s.optional;
				node.freshTarget = true;
				this.expnodes.set(s, node);
				connectValue(this.getExprNode(s.object), 0, node, 0);
				return false;
			}
			case 'index': {
				process(s);
				const node = this.makeExprNode(s);
				node.freshTarget = true;
				connectValue(this.getExprNode(s.object), 0, node, 0);
				connectValue(this.getExprNode(s.index), 0, node, 1);
				return false;
			}
			case 'conditional': {
				process(s);
				const node = this.makeExprNode(s);
				connectValue(this.getExprNode(s.test), 0, node, 0);
				connectValue(this.getExprNode(s.consequent), 0, node, 1);
				connectValue(this.getExprNode(s.alternate), 0, node, 2);
				return false;
			}
			case 'array': {
				process(s);
				const node = this.makeExprNode(s);
				s.elements.forEach((elem, index) => {
					if (elem)
						connectValue(this.getExprNode(elem), 0, node, index);
				});
				return false;
			}
			case 'object': {
				// A field/spread property threads a real value port, index-matched against s.properties.
				// A method/get/set gets its own function-scoped subgraph (entryNodeId, no graph edge of its own -- see buildClass) stored on classInfo instead --
				// invisible to a generic graph walk like isPureSubgraph, so any object literal with a method is tagged 'effect' unconditionally, like a class expression, so it's never
				// treated as freely inlinable/duplicable the way an ordinary pure value safely is.
				const hasMethod = s.properties.some(p => p.type === 'method' || p.type === 'get' || p.type === 'set');
				const node		= this.makeExprNode(s, hasMethod ? 'effect' : 'floating');
				if (hasMethod)
					this.connectEnd(node);

				const members: ClassMember[] = [];
				s.properties.forEach((prop, index) => {
					switch (prop.type) {
						case 'spread':
							recurse.expression(prop.operand);
							connectValue(this.getExprNode(prop.operand), 0, node, index);
							break;
						case 'method': case 'get': case 'set':
							if (typeof prop.key !== 'string')
								console.log(`not handling computed object key`);
							else if (!prop.body)
								console.log(`not handling object property ${prop.type} with no body`);
							else
								members[index] = { entryNodeId: this.buildFunctionBody(recurse, paramSlots(prop, recurse), prop.body).id };
							break;
						case 'field':
							if (typeof prop.key !== 'string') {
								console.log(`not handling computed object key`);
							} else {
								recurse.expression(prop.value);
								connectValue(this.getExprNode(prop.value!), 0, node, index);
							}
							break;
					}
				});
				if (hasMethod)
					node.classInfo = { members };
				return false;
			}
			case 'spread':
				// A bare spread node is only ever reached as an OPERAND of something else (a call
				// argument, an array/object element) -- never a standalone expression -- so it just
				// needs a real node to be addressable BY those consumers via getExprNode/connectValue,
				// carrying its own operand as a value input the same way 'unary' does.
				process(s);
				connectValue(this.getExprNode(s.operand), 0, this.makeExprNode(s), 0);
				return false;

			case 'as':
			case 'satisfies':
			case 'instantiation':
				// Pure type-level annotation, no runtime effect -- alias straight through to
				// whatever the wrapped expression resolves to instead of allocating a new node.
				process(s);
				this.expnodes.set(s, this.getExprNode(s.expression));
				return false;

			case 'sequence':
				// `(a, b, c)` evaluates all three in order but its own value is only the last --
				// without registering that, reading the sequence's own result throws "missing node".
				process(s);
				this.expnodes.set(s, this.getExprNode(s.expressions.at(-1)!));
				return false;
		}
		return false;
	}

	// ---- things only a class/object literal needs ----

	// Heritage and every member's own computed key are real expressions that can call out -- resolved
	// through VSDG (not a print-blind generic walk) so a referenced outer variable isn't silently
	// inlined/orphaned away. Each resolved value gets a REAL graph edge into `anchor` (ports 1.., 0
	// being the state predecessor): classInfo's own NodeId references alone are invisible to
	// ordinary consumer counting, so without an edge the value would look unused.
	buildClass(recurse: Recurse<Expr, Stmt>, anchor: N, s: { superClass?: JS.Expr<any>; body: JS.ClassMember<any>[] }): ClassInfo {
		let port = 1;
		let superClassNodeId: NodeId | undefined;
		if (s.superClass) {
			recurse.expression(s.superClass);
			const node = this.getExprNode(s.superClass);
			connectValue(node, 0, anchor, port++);
			superClassNodeId = node.id;
		}
		return {
			superClassNodeId,
			// Two ports per member (key, static field value) -- unused ones (a non-computed key, a
			// non-static/non-field member) just go unclaimed, harmless.
			members: s.body.map(m => {

				// A computed member key is a real expression, resolved through VSDG like any other and
				// wired into `anchor` at the next free port -- same reasoning as buildClass's own
				// comment above (a phantom, edge-less reference would look unused).
				let keyNodeId;
				if ('key' in m && typeof m.key !== 'string') {
					const expr = m.key.computed;
					recurse.expression(expr);
					const node = this.getExprNode(expr);
					connectValue(node, 0, anchor, port++);
					keyNodeId = node.id;
				}

				switch (m.type) {
					case 'method':
					case 'get':
					case 'set':
						return m.body ? { keyNodeId, entryNodeId: this.buildFunctionBody(recurse, paramSlots(m, recurse), m.body).id } : { keyNodeId };
					case 'static_block':
						return { entryNodeId: this.buildFunctionBody(recurse, undefined, m.body).id };
					case 'field': {
						if (!m.value)
							return { keyNodeId };
						if (m.modifiers?.includes('static')) {
							// A static field's initializer runs once, at class-definition time, same as
							// heritage/keys -- resolved and wired into `anchor` at its own port for the same
							// reason (without a real edge, it's a phantom reference that looks unused).
							recurse.expression(m.value);
							const valueNode = this.getExprNode(m.value);
							connectValue(valueNode, 0, anchor, port++);
							return { keyNodeId, valueNodeId: valueNode.id };
						}
						// An INSTANCE field's initializer runs once per `new`, not at class-definition time --
						// threading it into the outer chain directly would wrongly force it into a single,
						// one-time position. Reuses buildFunctionBody wholesale (own entry/return-anchor
						// pair, no params), `m.value` as an expression body -- the emitter's own
						// resolveFieldInitializer reads the resolved value straight off returnNode's port 1.
						return { keyNodeId, entryNodeId: this.buildFunctionBody(recurse, undefined, m.value).id };
					}
					default:
						// 'index_signature' has no runtime code at all (a type-only member).
						return { keyNodeId };
				}

			}),
		};
	}
}

// Desugars a destructuring BindingTarget into flat var_decls reading off valueExpr -- which MUST
// already be a stable, side-effect-free reference, never the raw initializer (a pattern reads its
// value multiple times). Reuses transform.ts's own version (shared with backend.ts) rather than a
// second copy; wrapped in try/catch since it hard-throws on two gaps (object rest, computed key)
// this file otherwise degrades gracefully on -- accepted since both are already rare.
function patternBindings(kind: JS.DeclarationKind, target: JS.BindingTarget, valueExpr: Expr): Stmt[] {
	try {
		return buildPatternBindings(kind, target, valueExpr);
	} catch (e) {
		console.log(`not handling destructuring pattern: ${e}`);
		return [];
	}
}

// ===================================================================
//  Reconstruction
// ===================================================================

// Wraps a reconstructed statement in `export `/`export default `, per a node's own `exported` stamp.
function wrapExported(stmt: Stmt, exported: 'named' | 'default' | undefined): Stmt {
	return exported === 'named' ? { type: 'export_decl', declaration: stmt } as Stmt
		: exported === 'default' ? { type: 'export', default: stmt } as Stmt
		: stmt;
}

export class TSEmitter extends Emitter<Expr, Stmt, Type> {
	constructor(graph: VSDG, blocks?: BlockTree, blockIds?: Map<NodeId, string>) {
		super(graph, tsDialect, blocks, blockIds);
	}

	// ---- statement constructors ----

	// `undefined` is "no body at all" (an absent `else`), which stays absent; an EMPTY array is a
	// genuinely empty body, which a braced block still spells out.
	makeBlock(body: Stmt[] | undefined) { return body === undefined ? undefined : Block(...body); }

	// JS/C bodies are ONE statement in the slot -- a `Block` when the source braced it, so the
	// braced/un-braced distinction survives -- which is why the dialect, not the core, wraps here.
	makeSwitch(discriminant: Expr, cases: { test?: Expr, consequent: Stmt[] }[]): Stmt {
		return JS.Switch(discriminant, ...cases);
	}
	// js's `catch (e)` binds a name and matches nothing, so the handler's type is always undefined.
	makeTry(body: Stmt[], handler: { param?: string, type?: Expr, body: Stmt[] }, finalizer?: Stmt[]): Stmt {
		return { type: 'try', body, handlers: [{ param: handler.param, body: handler.body }], finalizer } as Stmt;
	}
	makeThrow(argument: Expr): Stmt			{ return { type: 'throw', argument }; }
	makeTempDecl(name: string, value: Expr): Stmt { return JS.VarDecl('var', JS.Var(name, value)); }

	// ---- whole statements the core anchors on ----

	emitPassthru(node: NOf<'passthru'>): Stmt {
		return wrapExported(node.stmt, node.exported);
	}
	rebuildClassDecl(node: NOf<'class_decl'>): Stmt {
		return wrapExported(this.rebuildClass(node.stmt, node.classInfo!) as Stmt, node.exported);
	}
	rebuildFunctionDecl(node: NOf<'function'>, body: Stmt[]): Stmt {
		return wrapExported({ ...this.rebuildParams(node.stmt as JS.FunctionDecl<Type>, node), body } as Stmt, node.exported);
	}
	// A named slot's own printed statement: a declaration, a first assignment, or a reassignment.
	emitNamedSlot(name: string, node: N): Stmt | undefined {
		const first = !this.names.has(name);
		this.names.add(name);

		const slot = (): Stmt | undefined => {
			if (node.type === 'var') {
				const declKind = node.declKind as JS.DeclarationKind;
				if (!node.inputs[0])
					return JS.VarDecl(declKind, JS.Var(name, undefined, node.typeAnnotation));

				const forced = this.hasForcedSibling(name, node.id);
				// The initializer needn't print under x's name -- nothing reads x's value, or its sole
				// reader recomputes the pure initializer inline (an effectful dead one still runs, emitted
				// separately as an effect). A forced sibling reads x by name, so then x keeps its value.
				if (!this.graph.hasRealConsumer(node) || (this.isInlinableVarDecl(node) && !forced)) {
					// Keep a bare `let x;` only when the binding is still needed -- an export, or a forced
					// sibling assigning x. (`const x;` is syntax-invalid, downgrade to `let`.)
					return node.exported || forced
						? JS.VarDecl(node.declKind === 'const' ? 'let' : declKind, JS.Var(name, undefined, node.typeAnnotation))
						: undefined;
				}
				// The FIRST emit of a real source variable is its declaration; every emit after is a plain
				// reassignment (`first` is captured before the add at the top).
				const expr = this.resolveOperand(node.id, 0);
				return first
					? JS.VarDecl(declKind, JS.Var(name, expr, node.typeAnnotation))
					: ExprStmt(Assign<Expr, JS.assignableOps>(Identifier(name), expr));
			}
			if ((node.type === 'mutation' && node.expr.type === 'unary') || node.type === 'unary_post') {
				// A prefix or postfix ++/-- already performs its own assignment as a side effect -- printed
				// as a bare expression statement, `++i;`/`i++;` is both correct and sufficient. Wrapping it
				// in a reassignment would give a redundant self-assignment: `i = ++i;`/`i = i++;`.
				return ExprStmt(this.rebuildPayload(node));
			}
			return ExprStmt(Assign<Expr, JS.assignableOps>(Identifier(name), this.buildExpr(node)));
		};

		const stmt = slot();
		return stmt && wrapExported(stmt, node.exported);
	}

	// ---- expressions ----

	rebuildPayload(node: N): Expr {
		switch (node.type) {
			case 'unary_post':
				return { ...(node.expr as Extract<Expr, {type: 'unary_post'}>), operand: this.resolveTarget(node.id, 0) };
			case 'unary_post_old':
				// resolveOperand, NOT resolveTarget: the snapshot's whole job is to freeze the value
				// BEFORE the increment, so it must share the target's own materialised read rather
				// than evaluating the property a second time (which `freshTarget` forces).
				return this.resolveOperand(node.id, 0);
			case 'member':
				return JS.Member(this.resolveOperand(node.id, 0), node.name, node.optional);
			case 'floating':
				return this.rebuildFloating(node, node.expr);
			case 'mutation':
				return this.rebuildMutationValue(node);
			case 'effect':
				return this.rebuildEffect(node);
		}
		console.log(`not handling value node ${node.type}`);
		return Literal(null);
	}

	// A mutation read as a VALUE rather than printed as its own statement -- only the value it
	// produces is wanted, and a member/index target must rebuild fresh (see resolveTarget).
	rebuildMutationValue(node: NOf<'mutation'>): Expr {
		const expr = node.expr;
		switch (expr.type) {
			case 'unary':
				return { ...expr, operand: this.resolveTarget(node.id, 0) };
			// The base operator is stored on the node now, so no `=` has to be sliced back off.
			case 'assign': {
				const right = this.resolveOperand(node.id, 1);
				return expr.operator
					? Binary(expr.operator, this.resolveTarget(node.id, 0), right)
					: right;
			}
		}
		console.log(`not handling value node ${node.type}`);
		return Literal(null);
	}

	rebuildMutationStatement(node: NOf<'mutation'>): Stmt {
		const expr = node.expr;
		return ExprStmt(node.plainAssign && expr.type === 'assign'
			? { ...expr, target: this.resolveTarget(node.id, 0), value: this.resolveOperand(node.id, 1) }
			: this.rebuildPayload(node));
	}

	// Every ordinary, genuinely pure value-producing expression shares the one 'floating' tag -- see
	// the builder's own makeExprNode comment -- so node.expr's own .type picks the shape here.
	rebuildFloating(node: N, expr: Expr): Expr {
		switch (expr.type) {
			case 'literal':
			case 'this':
			case 'super':		return expr;
			case 'unary':		return { ...expr, operand: this.resolveOperand(node.id, 0) };
			case 'array':		return { ...expr, elements: expr.elements.map((elem, i) => elem ? this.resolveOperand(node.id, i) : elem) };
			case 'object':		return this.buildObjectExpr(node, expr);
			case 'spread':		return { ...expr, operand: this.resolveOperand(node.id, 0) };
			case 'binary':		return { ...expr, left: this.resolveOperand(node.id, 0), right: this.resolveOperand(node.id, 1) };
			case 'conditional':	return this.buildConditional(node);
			case 'index':		return { ...expr, object: this.resolveOperand(node.id, 0), index: this.resolveOperand(node.id, 1) };
			case 'call':		return { ...expr, arguments: expr.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
		}
		console.log(`not handling value node ${expr.type}`);
		return Literal(null);
	}

	// Shared by buildObjectExpr's caller and the effect path below -- the reconstruction itself
	// doesn't care which tag got it here, only whether classInfo has a resolved method body for
	// this particular property.
	buildObjectExpr(node: N, expr: Expr & {type: 'object'}): Expr {
		return {
			...expr,
			properties: expr.properties.map((prop, i) => {
				if (prop.type === 'spread')
					return { ...prop, operand: this.resolveOperand(node.id, i) };
				const mi = node.classInfo?.members[i];
				if (mi?.entryNodeId)
					return { ...prop, body: this.rebuildFunctionBody(this.graph.getNode(mi.entryNodeId) as NOf<'function'>) as JS.Stmt<Type>[] };
				return prop.type === 'field' && typeof prop.key === 'string' ? { ...prop, value: this.resolveOperand(node.id, i) } : prop;
			}),
		};
	}

	rebuildEffect(node: NOf<'effect'>): Expr {
		const value = node.expr;
		switch (value.type) {
			// `await x` -- always has a real operand (unlike 'yield', which can be bare). The graph
			// threads that operand at port 1, so the resolved one is what has to print.
			case 'await':
				return { ...value, operand: this.resolveOperand(node.id, 1) };
			// A method/get/set-bearing object literal -- reconstructed via the same shared helper a
			// field-only one uses; classInfo is what needs the graph, not the tag itself.
			case 'object':
				return this.buildObjectExpr(node, value);
			case 'yield':
				return { ...value, operand: value.operand ? this.resolveOperand(node.id, 1) : undefined };
			case 'tagged_template':
				return { ...value, quasi: value.quasi.map((part, i) => part.exp ? { ...part, exp: this.resolveOperand(node.id, i + 1) } : part) };
			case 'class':
				return node.classInfo ? this.rebuildClass(value, node.classInfo) : value;
			case 'jsx': {
				let port = 1;
				return {
					...value,
					attributes: value.attributes.map(a => a.value ? { ...a, value: this.resolveOperand(node.id, port++) } : a),
					children: value.children.map(() => this.resolveOperand(node.id, port++)),
				};
			}
			case 'call': case 'new': {
				// A call/new's own callee is normally left raw, unresolved -- wrong only when it embeds
				// a real effect (e.g. `new Point(3,4).sum()`), since the graph also threads that effect
				// into the state chain as its own node, and printing raw source there would duplicate
				// its execution. Reuses the same edge added for consumer-counting (the builder's own
				// 'call'/'new' cases) rather than a second way to reach the callee's node.
				const calleeEdge = node.inputs[value.arguments.length + 1];
				const calleeNode = calleeEdge && this.graph.get(calleeEdge.nodeId);
				// A PURE callee can still have been forced to materialize as its own named temp (e.g.
				// hoisted loop-invariant) -- printing value.callee verbatim would duplicate the raw
				// source instead of referencing that temp, discarding the point of hoisting it.
				const calleeTemp = calleeNode && this.nodeVariableNames.get(calleeNode.id);
				const callee = calleeTemp ? Identifier(calleeTemp)
					: calleeNode && !this.graph.isPureSubgraph(calleeNode) ? this.resolveNode(calleeNode.id) : value.callee;
				return { ...value, callee, arguments: value.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
			}
			default:
				return value;	// can't get here
		}
	}

	// ---- class / signature reconstruction ----

	// A destructured param prints as its own hidden temp name in the SIGNATURE too, not just the
	// body -- see destructuredParams. A no-op when this entry has no destructured params at all.
	rebuildParams<T extends JS.Params<Type>>(raw: T, entryNode: NOf<'function'>): T {
		if (!entryNode.destructuredParams)
			return raw;
		const rebuildKey = <P extends { key: JS.BindingTarget }>(p: P): P => {
			const tempName = entryNode.destructuredParams!.get(p.key);
			return tempName !== undefined ? { ...p, key: tempName } : p;
		};
		return { ...raw, params: raw.params.map(rebuildKey), rest: raw.rest && rebuildKey(raw.rest) };
	}

	// Splices VSDG's own resolution of a class's heritage/keys/method bodies back into its otherwise
	// verbatim member list. `raw` is loosely typed since both a class expression and a class_decl
	// statement reach here, differing only in a few fields this never touches.
	rebuildClass(raw: any, info: ClassInfo): any {
		return {
			...raw,
			superClass: info.superClassNodeId ? this.resolveNode(info.superClassNodeId) : raw.superClass,
			body: raw.body.map((m: any, i: number) => {
				const mi = info.members[i];
				if (!mi)
					return m;
				const withKey = mi.keyNodeId ? { ...m, key: { computed: this.resolveNode(mi.keyNodeId) } } : m;
				if (mi.valueNodeId)
					return { ...withKey, value: this.resolveNode(mi.valueNodeId) };
				if (m.type === 'field')
					return mi.entryNodeId
						? { ...withKey, value: this.resolveOperand((this.graph.getNode(mi.entryNodeId) as NOf<'function'>).returnNodeId, 1) }
						: withKey;
				if (!mi.entryNodeId)
					return withKey;
				const entryNode = this.graph.getNode(mi.entryNodeId) as NOf<'function'>;
				return { ...this.rebuildParams(withKey, entryNode), body: this.rebuildFunctionBody(entryNode) };
			}),
		};
	}
}

// ===================================================================
//  The pipeline
// ===================================================================

export function BuildVSDG(ast: readonly Stmt[]): VSDG {
	const builder = new TSBuilder();
	builder.build(ast);
	return builder.finish();
}

export function Optimize(graph: VSDG): void {
	optimize(graph, tsDialect);
}

export function BuildProgram(
	graph:		VSDG,
	blocks?:	BlockTree,
	blockIds?:	Map<NodeId, string>
): Stmt[] {
	return new TSEmitter(graph, blocks, blockIds).build();
}

// Kept for callers that drive CSE directly; `Optimize` runs it as its own final round.
export function optimizeStructuralCSE(graph: VSDG, protectedIds: Set<NodeId>): boolean {
	return structuralCSE(graph, tsDialect, protectedIds);
}
