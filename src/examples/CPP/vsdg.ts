// ===================================================================
//  The C++ half of the language-neutral VSDG.
// ===================================================================
// Same three pieces as TS/vsdg.ts and PY/vsdg.ts: `CPPDialect` (the facts the core asks about),
// `CPPBuilder` (this AST's tags onto graph nodes), `CPPEmitter` (graph nodes back onto this AST,
// printed by CPP/printer.ts) -- plus, at the bottom, the pipeline entry points this language exposes:
//
//     BuildVSDG(defs) -> Optimize(graph) -> applyGlobalCodeMotion(graph) -> BuildProgram(graph)
//
// Where C++ differs from both existing dialects, the difference is absorbed here:
//
//   * THE TOP LEVEL IS DEFINITIONS, not statements. A function definition is not a `Stmt` on this AST
//     at all, so `S` is the widened `TopLevel = Definition | Stmt`, and the walker's own
//     definition/statement split is bridged in `walkerB` (see DEFINITION_ONLY);
//   * a declaration carries its TYPE, so a `var` node's `T` is the whole `DeclarationSpec`. There is
//     no `let`/`const` keyword to print, and -- unlike every other dialect -- a name's type can never
//     be invented, which is why an assignment to a name nobody modelled (`x = 1;`) prints as a plain
//     assignment rather than as a declaration;
//   * assignment is an EXPRESSION and `++`/`--` are pre/post mutations, so neither is ever treated as
//     an ordinary pure value (see `lowerAssign` and the effect fallback);
//   * a body is ONE `Block` statement, not an array (unlike py), so it's handed to
//     `buildFunctionBody` as a one-element list and reaches the builder's own 'block' case.
//
// Deliberately NOT modelled yet -- each prints verbatim, so output stays correct and everything the
// text mentions keeps a real reader, but the construct's interior isn't scheduled or optimised:
// classes/structs/unions/templates/namespaces/`using`, typedefs, `switch`, `goto`/labels,
// `throw`/`try`, range-`for`, initializer lists, declarators that aren't a plain name
// (`int *p` / `a[10]` / `f(int)`), and the expressions `new`/`delete`/lambdas/`functional_cast`/
// `cpp_cast`/`typeid`/`alignof`/`++`/`--`.
//
// `++`/`--` are the one exception to that list's "nothing is modelled": the expression still prints
// verbatim (see `lowerUnmodelledMutation` for why C++ gives no safe way to do better), but the NAME it
// rewrites IS re-bound afterwards, because an unmodelled mutation that leaves the name alone lets CSE
// merge a read from before it with one from after it.
//
// Constant FOLDING has a TYPE MODEL of its own, because C++'s arithmetic is defined in terms of one
// (unsigned wraps, `/` truncates, `-1 < 1u` is false). It is worth exactly what a literal's own
// spelling can pin down -- the model lives in `walker.ts`, beside the walker (as TS/PY keep their own
// `calcBinary`/`calcUnary` there), and `cppDialect` below just asks it. It is not visible to the core:
// `literalValue`/`foldValue`/`literal` pass it through `unknown`.

import * as C from './c-parser';
import * as CPP from './cpp-parser';
import * as Common from '../common';
import { walkerB as makeWalkerB, isExpr, isPackParameter, calcBinary, calcUnary, Scalar, scalarFor, spellScalar } from './walker';
import { printer as cppPrinterFactory } from './printer';
import {
	Dialect, VSDGBuilder, Emitter, Recurse, ParamSlot, SwitchSyntax,
	Node, NodeOf, NodeType, NodeId, Scope, VSDG, BlockTree,
	connectValue, slotName,
	optimize, optimizeStructuralCSE as structuralCSE
} from '../vsdg';

type Expr		= CPP.Expr;
type Stmt		= CPP.Stmt;
type Definition	= CPP.Definition;
// What one top-level item is: `BuildVSDG` is handed a module body, `BuildProgram` hands one back.
type TopLevel	= Definition | Stmt;
// The `var` node's own `T`: everything needed to print a declaration's type, storage class included.
type Spec		= CPP.DeclarationSpec;
type FunctionDef = C.FunctionDef<CPP.Declarator, CPP.TypeSpecifierExt, Expr, Stmt>;

type N			= Node<Expr, TopLevel, Spec>;
type NOf<K extends NodeType> = NodeOf<Expr, TopLevel, Spec, K>;

// ===================================================================
//  Which top-level items are definitions
// ===================================================================
// The walker keeps definitions and statements apart (`Kinds`), while the core has one entry point per item -- so the two have to be matched back up.
// Only the tags that CANNOT be a statement need routing to the definition walker; `declaration`/`typedef`/`static_assert`/`using` appear in both
// unions and are handled identically by either, so they stay on the statement path.
const DEFINITION_ONLY = new Set<string>([
	'function_def', 'namespace', 'linkage', 'template', 'method_def', 'operator_def', 'constructor_def', 'destructor_def', 'static_member_def',
]);

export function isDefinition(s: TopLevel): s is Definition {
	return DEFINITION_ONLY.has(s.type);
}


// ===================================================================
//  Dialect
// ===================================================================

let printerInstance: ReturnType<typeof cppPrinterFactory> | undefined;
const cppPrinter = () => (printerInstance ??= cppPrinterFactory());

export const cppDialect: Dialect<Expr, TopLevel, Spec> =  {
	identifierName(e) {
		return e.type === 'identifier' ? e.name : undefined;
	},
	identifier(name) {
		return Common.Identifier(name);
	},
	literal(value) {
		// A folded scalar knows its own type, and spells itself from it. The core's own values reach here
		// too: a rotated loop's condition is `literal(true)`, which this AST spells `true` (the value 1
		// is what `isTrueLiteral` recognises), and the buildExpr fallback is `null`.
		if (typeof value === 'boolean')
			return Common.Literal(1, value ? 'true' : 'false');
		const s = value as Scalar | null;
		return s && typeof s === 'object' && 'kind' in s
			? Common.Literal(s.value, spellScalar(s))
			: Common.Literal(value as number | string);
	},
	// `true` is NOT a literal on this AST -- it lexes as an identifier (`declaratorName` can't tell
	// either), and `while (1)` is the same thing spelled idiomatically. Both mean the loop's exit test
	// is provably non-falsifying, which is all the core asks.
	isTrueLiteral(e) {
		return (e.type === 'identifier' && e.name === 'true')
			|| (e.type === 'literal' && e.value === 1);
	},
	exprKey(e) {
		return cppPrinter().expression(e);
	},
	stmtKey(s) {
		return isDefinition(s)
			? cppPrinter().definition(s)
			: cppPrinter().statement(s);
	},
	isCSEUnsafe(node) {
		// A read whose VALUE an intervening mutation can change, while its printed form stays
		// identical: `a[i]` (C++'s `[]` can call a user-defined `operator[]`), `this` (bound per
		// call), and `A::b` (a global, or a static member). `a.b` never reaches here -- CSE skips the
		// 'member' tag by type already.
		return node.type === 'floating'
			&& (['index', 'this', 'qualified'] as Expr['type'][]).includes(node.expr.type);
	},
	foldable(node) {
		// Shape only: which OPERATORS actually fold is `foldValue`'s own answer (see foldBinary).
		return node.type !== 'floating' ? 0
			: node.expr.type === 'binary' ? 2
			: node.expr.type === 'unary' ? 1
			: 0;
	},
	foldValue(node, ops) {
		if (node.type !== 'floating')
			return undefined;
		// Every operand reached here through `literalValue`, so each one is a `Scalar`.
		return	node.expr.type === 'binary'	? calcBinary(node.expr.operator, ops[0] as Scalar, ops[1] as Scalar)
			: node.expr.type === 'unary'	? calcUnary(node.expr.operator, ops[0] as Scalar)
			: undefined;
	},
	// What is a constant here: a literal, whose own spelling is its type, and a single-character `'a'`,
	// which is an `int` after promotion. A string literal is a pointer, `nullptr` has a type but no
	// value, and `sizeof(T)` needs the declarations this AST never resolves.
	literalValue(e) {
		if (e.type === 'char_literal')
			return e.value.length === 1 ? { kind: 'int', value: e.value.charCodeAt(0) & 0xFF } : undefined;
		return e.type === 'literal' && typeof e.value === 'number' ? scalarFor(e.value, e.raw) : undefined;
	},
	// C++'s zero is falsy for every scalar kind -- including the `0.0` a float carries, and the 0 a
	// folded `false` does.
	truthy(value) {
		return (value as Scalar).value !== 0;
	},
	isCalleeEdge(consumer, port) {
		const v = consumer.type === 'effect' && consumer.expr;
		return !!v && v.type === 'call' && port === v.arguments.length + 1;
	}
};


// ===================================================================
//  Lowering
// ===================================================================

// This language's own parameter list -> the core's neutral slots. A parameter's name comes out of
// whatever declarator shape it was spelled with (`declaratorName` digs through pointer/array/reference
// wrappers), so `int *p` binds `p` like any other name. An unnamed parameter binds nothing: only the
// signature's own verbatim text mentions it.
// c-parser's own `declaratorName` is typed against ITS declarator (no reference wrappers), so the same
// dig has to be spelled once more against this module's wider one.
function declaratorName(d: CPP.Declarator): string {
	switch (d.type) {
		case 'identifier':			return d.name;
		case 'pointer':
		case 'reference':
		case 'rvalue_reference':	return declaratorName(d.to);
		case 'array':				return declaratorName(d.element);
		case 'function':			return declaratorName(d.name);
		default:					throw new Error(`vsdg/cpp: no name behind declarator ${(d as {type: string}).type}`);
	}
}

/** The type every one of switch's own hidden helpers is declared with: C++ has no keyword-less
 *  declaration form (see `makeTempDecl`), and the source never spells a type for them either. */
const AUTO: Spec = { type: C.RefType('auto') };

/** C's switch body is a FLAT list of statements -- `case 1: g(); break;` parses as three siblings, the
 *  label holding only its own FIRST statement -- so the labels have to be regrouped into one entry per
 *  case, exactly as `transpile.ts`'s own `cppSwitchToTs` does it. A label whose own body is another
 *  label (`case 1: case 2: g();`) chains through it. Undefined for a shape this can't regroup (a
 *  statement before the first label, a second `default:`) -- those stay verbatim, which is correct. */
function switchCasesOf(s: Stmt & { type: 'switch' }): { test?: Expr, body: Stmt[] }[] | undefined {
	if (s.body.type !== 'block')
		return undefined;
	const cases: { test?: Expr, body: Stmt[] }[] = [];
	let sawDefault = false;
	const add = (item: TopLevel): boolean => {
		if (item.type === 'case' || item.type === 'default') {
			if (item.type === 'default' && sawDefault)
				return false;
			sawDefault ||= item.type === 'default';
			cases.push({ test: item.type === 'case' ? item.test : undefined, body: [] });
			return add(item.body);
		}
		if (cases.length === 0)
			return false;
		cases[cases.length - 1].body.push(item as Stmt);
		return true;
	};
	for (const item of s.body.body)
		if (!add(item))
			return undefined;
	return cases;
}

function paramSlots(declarator: CPP.Declarator): ParamSlot[] | undefined {
	return declarator.type === 'function' ? paramSlotsOf(declarator.params) : undefined;
}

/** The same, for a parameter list no declarator wraps -- a lambda's own. */
function paramSlotsOf(params: readonly CPP.ParamDecl[]): ParamSlot[] {
	const slots: ParamSlot[] = [];
	for (const p of params) {
		if (isPackParameter(p))
			continue;
		if (p.declarator)
			slots.push({ name: declaratorName(p.declarator) });
	}
	return slots;
}

export class CPPBuilder extends VSDGBuilder<Expr, TopLevel, Spec> implements SwitchSyntax<Expr, TopLevel, Spec> {
	constructor() { super(cppDialect); }

	build(ast: readonly Definition[]) {
		const w = makeWalkerB(
			(d, process, recurse) => this.lowerDefinition(d, process, recurse),
			(s, process, recurse) => this.lowerStatement(s, process, recurse),
			(e, process, recurse) => this.lowerExpression(e, process, recurse)
		);
		return ast.some(x => isDefinition(x) ? w.definition(x) : w.statement(x));
	}

	lowerDefinition(d: Definition, process: (d: Definition) => boolean, recurse: Recurse<Expr, TopLevel>): boolean {
		if (d.type === 'function_def' && this.modellable(d)) {
			// The body is a single `Block` statement on this AST, not an array -- handing it over as a
			// one-element list is what routes it through the builder's own 'block' case, which is what
			// gives the body its own scope.
			const fn = this.buildFunctionBody(recurse, paramSlots(d.declarator), [d.body]);
			fn.stmt = d;
			this.end = fn;
			return false;
		}
		console.log(`not handling definition ${(d as {type: string}).type}`);
		return this.lowerVerbatim(d, () => process(d));
	}

	// A function definition this builder can lower: a plain function whose parameters are all
	// bindable names. A parameter with a DEFAULT is not -- its default's own text only ever appears in
	// the verbatim signature, so a name that default mentions would look unreferenced and get elided.
	private modellable(d: FunctionDef): boolean {
		if (d.declarator.type !== 'function')
			return false;
		for (const p of d.declarator.params)
			if (isPackParameter(p) || p.default)
				return false;
		return true;
	}

	lowerStatement(s: TopLevel, process: (s: Stmt) => boolean, recurse: Recurse<Expr, TopLevel>): boolean {
		// c-parser keeps BOTH readings of a construct it found ambiguous -- an unknown type name makes
		// `S *p = 0;` fork into a pointer declaration and a multiplication, and the two are returned as
		// a nested list. They are ALTERNATIVES, not a sequence: lowering both runs the statement twice
		// (and the second reading usually isn't the one the source meant). The first is taken, which is
		// also the only reading a printer that can't spell an alternative list could ever emit.
		if (Array.isArray(s)) {
			console.log(`ambiguous statement: ${s.length} readings, taking the first`);
			if (s.length)
				recurse.statement(s[0] as TopLevel);
			return false;
		}
		// Everything else that reaches here IS a statement: `walkerB` routed the definition-only tags to
		// `lowerDefinition`, and every other `Definition` member is also a statement tag.
		const stmt = s as Stmt;
		switch (stmt.type) {
			case 'declaration':
				if (this.lowerDeclaration(recurse, stmt))
					return false;
				console.log(`not handling declaration`);
				return this.lowerVerbatim(stmt, () => process(stmt));

			case 'block':
				this.scope = new Scope(this.scope);
				process(stmt);
				this.scope = this.scope.closeAndFlush()!;
				return false;

			case 'if': {
				recurse.expression(stmt.test);
				const test		= this.getExprNode(stmt.test);
				const parent	= this.getState();
				const trueState		= this.walkBranch(parent, () => recurse.statement(stmt.consequent));
				const falseState	= this.walkBranch(parent, () => { if (stmt.alternate) recurse.statement(stmt.alternate); });
				this.mergeState(parent, test, trueState, falseState);
				this.reconcileVariables(parent, test, trueState, falseState);
				return false;
			}

			case 'while':
				this.buildLoop(recurse, stmt.test, () => recurse.statement(stmt.body), false);
				return false;

			case 'do_while':
				// The body runs BEFORE the test (the mu's initial value is what it sees first).
				this.buildLoop(recurse, stmt.test, () => recurse.statement(stmt.body), true);
				return false;

			case 'switch': {
				const cases = switchCasesOf(stmt);
				// An empty switch (or a shape that won't regroup) has no case body that could break, so it
				// stays verbatim -- which also beats declaring the hidden helpers for nothing.
				if (!cases?.length) {
					console.log(`not handling switch body`);
					return this.lowerVerbatim(stmt, () => process(stmt));
				}
				this.buildSwitch(recurse, stmt.discriminant, cases.map(c => ({
					test: c.test,
					body: () => { for (const s of c.body) recurse.statement(s); },
				})), this);
				return false;
			}

			case 'for': {
				// Run init once, then desugar to `while (test) { body; update; }` with the update folded
				// into the body's own non-`continue` tail -- same shape TS's own `for` lowering uses.
				if (stmt.init) {
					if (isExpr(stmt.init))
						recurse.expression(stmt.init);
					else
						recurse.statement(stmt.init);	// a declaration in the init clause
				}
				const test	= stmt.test ?? Common.Literal(1);
				const body: Stmt = stmt.update ? Common.Block<Stmt>(stmt.body, Common.ExprStmt(stmt.update)) : stmt.body;
				this.buildLoop(recurse, test, () => recurse.statement(body), false, stmt.update);
				return false;
			}

			case 'return': {
				// The marker carries its value at port 1 (unconnected for a bare `return;`); `exited`
				// makes an enclosing `if` build a real gamma around this path.
				if (stmt.argument)
					recurse.expression(stmt.argument);
				const marker = this.makeMarker('EARLY_RETURN_MARKER');
				this.connectEnd(marker);
				if (stmt.argument)
					connectValue(this.getExprNode(stmt.argument), 0, marker, 1);
				this.exited = true;
				return false;
			}
			case 'break':
				this.connectEnd(this.makeMarker('BREAK_MARKER'));
				this.exited = true;
				this.brokeOut = true;
				return false;
			case 'continue':
				this.connectEnd(this.makeMarker('CONTINUE_MARKER'));
				this.exited = true;
				return false;

			case 'empty':
				return false;

			case 'expression':
				// A call reaches the state chain from inside `lowerExpression`'s own 'call' case, so
				// descending is all this needs; anything with no effect at all is dead and drops.
				break;

			default:
				// `switch`/`case`/`goto`/labels/`throw`/`try`/range-`for`/`typedef`/`using`/... -- all of
				// it prints verbatim, with everything it mentions kept alive by the descent.
				console.log(`not handling statement ${(stmt as {type: string}).type}`);
				return this.lowerVerbatim(stmt, () => process(stmt));
		}
		return process(stmt);
	}

	// `int x = 1;` -- one graph binding per declarator, each printing as its own declaration. Only a
	// plain initialised name is modelled:
	//   * `int *p = ...` needs its own TYPE rewrite (`int *p` is not `int p`), which the declarator
	//     system would have to be modelled to do;
	//   * `int x;` with no initializer has no value to bind, but must still PRINT -- nothing else may
	//     declare it -- so it stays verbatim.
	private lowerDeclaration(recurse: Recurse<Expr, TopLevel>, s: Stmt & { type: 'declaration' }): boolean {
		const declarators = s.initDeclarators;
		if (!declarators?.length)
			return false;
		for (const d of declarators)
			if (!('declarator' in d) || d.declarator.type !== 'identifier' || !d.initializer || !isExpr(d.initializer))
				return false;

		// Walked THEN bound, one declarator at a time -- C++'s declarators also bind strictly left to
		// right, so `int i = 0, e = i + 1;` needs `i` already in scope for `e`'s own read.
		for (const d of declarators as { declarator: Common.Identifier, initializer: Expr }[]) {
			recurse.expression(d.initializer);
			const varNode = this.makeNode({ type: 'var', name: d.declarator.name });
			connectValue(this.getExprNode(d.initializer), 0, varNode, 0);
			// The declaration's own type, replayed by `emitNamedSlot`. No declKind: this AST has no
			// declaration keyword, and the core's `isInlinableVarDecl` reads declKind as "this value may be
			// elided" -- which would make an assignment's own TARGET resolve to the initializer (`0 = 1`).
			// What keeps the declaration printed is `typeAnnotation` (see the core's own
			// `needsDirectPlacement`) plus this emitter's own `nameStoredTo`.
			varNode.typeAnnotation = s.specifiers;
			this.bindVar(varNode);
		}
		return true;
	}

	// Every assignment, statement-level or as a subexpression. The graph node is a 'mutation' either
	// way; only WHERE the target lives decides what else it needs.
	private lowerAssign(recurse: Recurse<Expr, TopLevel>, e: Common.Assign<Expr, C.assignableOps>): boolean {
		recurse.expression(e.target);
		recurse.expression(e.value);
		const node = this.makeExprNode(e, 'mutation');
		node.plainAssign = e.operator === undefined;
		connectValue(this.getExprNode(e.target), 0, node, 0);
		connectValue(this.getExprNode(e.value), 0, node, 1);

		if (e.target.type === 'identifier') {
			const fresh = this.scope.get(e.target.name) === undefined;
			// A name this builder never saw declared is either a global or something a verbatim
			// statement declared: it's read by NAME only, and a store to it is observable, so the
			// assignment always prints (and prints as a plain assignment, never as a declaration -- the
			// type is exactly what isn't known here).
			if (fresh || !this.scope.isLocalToCurrentFunction(e.target.name))
				node.forcedPrint = true;
			this.rebindVar(e.target.name, node, fresh);
		} else {
			// A member/subscript target mutates something outside this pass's scope tracking, so
			// nothing reads it back through scope -- it must print regardless of consumer count.
			node.forcedPrint = true;
			this.threadMutation(node);
		}
		return false;
	}

	// A name whose only mention is TEXT the graph never prints -- a verbatim statement's, a lambda's
	// capture list -- still needs a READER, or the declaration it depends on is elided as dead. The
	// reader itself is consumer-less, so it never prints a statement of its own.
	private readOnly(e: Expr) {
		connectValue(this.getExprNode(e), 0, this.makeExprNode(e), 0);
	}

	/**
	 * A `++`/`--` this dialect does not model: the EXPRESSION becomes an opaque effect holding the raw
	 * payload, printed where it stands. C++'s own text already means "increment, and yield the old (or
	 * new) value", and rewriting it is unsafe here for a reason js doesn't have -- a user-defined
	 * `operator++` is a real call, and its old value is a COPY (`auto t0 = x; x++;` is not `g(x++)` for a
	 * class type), which no amount of graph work can tell apart from a scalar without the type.
	 *
	 * What IS modelled is the name it rewrites. Re-binding it to a fresh, never-bound 'var' is what stops
	 * a read on the far side of the increment from being the same NODE as one before it -- and since CSE
	 * merges equal nodes, without this `g(i * 2); i++; h(i * 2);` printed `auto t0 = i * 2;` with the
	 * PRE-increment product handed to `h`. (A member/index target needs nothing: each of its reads is its
	 * own `member`/`index` node, and both tags are CSE-skipped.)
	 */
	private lowerUnmodelledMutation(e: { type: 'unary' | 'unary_post', operand: Expr } & Expr): false {
		console.log(`not handling expression ${e.type}`);
		const node = this.makeExprNode(e, 'effect');
		this.connectEnd(node);

		const name = this.dialect.identifierName(e.operand);
		if (name !== undefined) {
			// The operand is a real READ of `name` -- it is what the increment yields -- so it needs an
			// edge of its own (port 1; nothing reads it, the payload prints verbatim). Without one the
			// name looks unread, and a later `i++` would not be seen to depend on this one, which is what
			// makes the dead-store claim below safe to make at all.
			connectValue(this.getExprNode(e.operand), 0, node, 1);
			// Same shape as an import binding: a name-only 'var', never `bound`, so it prints nothing (see
			// `emitNamedSlot`'s first branch) and every read of it resolves by name. Its own threadMutation
			// anchor is what orders those reads after this increment.
			const alias = this.makeNode({ type: 'var', name });
			this.threadMutation(alias);
			this.scope.set(name, alias);
			// Beyond rewriting this name, a builtin `++`/`--` does nothing -- so between them, the name and the
			// increment account for everything it does, and with nothing reading that binding the core drops
			// the whole thing as a dead write. `name` was not declared as anything in particular here:
			// whether `operator++` is really the builtin one is a TYPES question this pass cannot answer, so
			// "builtin" is the documented assumption, the same stand-in as `pure<name>` for calls. A
			// member/index target claims nothing -- an `operator[]`/`operator++` behind it can do anything.
			node.mutatesBindingId = alias.id;
		}
		return false;
	}

	// ---- SwitchSyntax: C++'s own spelling of switch's fixed scaffolding (the walk is the core's) ----

	local(value: Expr, name: string) {
		const node = this.makeNode({ type: 'var', name, typeAnnotation: AUTO });
		connectValue(this.getExprNode(value), 0, node, 0);
		return node;
	}
	comparison(discName: string, test: Expr): Expr {
		return Common.Binary<Expr, C.binaryOps>('==', Common.Identifier(discName), test);
	}
	// `default` matches iff none of the OTHER cases did, wherever it sits.
	condition(hitName: string, matchName: string | undefined, otherMatches: string[]): Expr {
		const hit = Common.Identifier(hitName);
		if (matchName !== undefined)
			return Common.Binary<Expr, C.binaryOps>('||', hit, Common.Identifier(matchName));
		return Common.Binary<Expr, C.binaryOps>('||', hit, otherMatches.length === 0
			? Common.Identifier('true')
			: Common.Unary<Expr, C.unaryOps>('!', otherMatches.map((n): Expr => Common.Identifier(n))
				.reduce((a, b) => Common.Binary<Expr, C.binaryOps>('||', a, b))));
	}
	// `true`/`false` are IDENTIFIERS on this AST (no boolean literal) -- see the dialect's `isTrueLiteral`.
	setHit(hitName: string): Expr {
		return Common.Assign<Expr, C.assignableOps>(Common.Identifier(hitName), Common.Identifier('true'));
	}

	lowerExpression(e: Expr, process: (e: Expr) => boolean, recurse: Recurse<Expr, TopLevel>): boolean {
		switch (e.type) {
			case 'identifier':
				// A statement printed VERBATIM mentions this name in text the graph never prints -- but the
				// mention still has to look like a READ, or a declaration that text depends on is elided as
				// dead (`int x = 1; switch (x) {...}` lost its declaration, since the switch is verbatim and
				// nothing else read `x`). The reading node is created inside a verbatim descent, so it is
				// inherently `suppressed` and never prints itself.
				if (this.verbatim)
					this.readOnly(e);
				return false;

			case 'literal': {
				process(e);
				this.makeExprNode(e);
				return false;
			}

			case 'char_literal':
			case 'sizeof_type':
			case 'null_literal':
			case 'this':
			case 'qualified':
				// A leaf with nothing to thread. `'a'` IS a constant (see the dialect's `literalValue`),
				// while `sizeof(T)`/`nullptr` are not. `this`/`A::b` are marked CSE-unsafe by the dialect.
				process(e);
				this.makeExprNode(e);
				return false;

			case 'unary': {
				process(e);
				// `++x`/`--x` mutate, so they must never be mistaken for a pure value.
				if (e.operator === '++' || e.operator === '--')
					return this.lowerUnmodelledMutation(e);
				connectValue(this.getExprNode(e.operand), 0, this.makeExprNode(e), 0);
				return false;
			}

			case 'unary_post':
				// `x++`/`x--` likewise -- and their value is the PRE-mutation one, which C++ gives no safe
				// way to rewrite either (see `lowerUnmodelledMutation`).
				process(e);
				return this.lowerUnmodelledMutation(e);

			case 'binary': {
				process(e);
				const node = this.makeExprNode(e);
				connectValue(this.getExprNode(e.left), 0, node, 0);
				connectValue(this.getExprNode(e.right), 0, node, 1);
				return false;
			}

			case 'assign':
				return this.lowerAssign(recurse, e);

			case 'lambda': {
				// The same 'function' entry a definition gets, with `.expr` set: the lambda's own text is a
				// VALUE printed verbatim, while its BODY is lowered into that entry's own region. Descending
				// into it here instead -- which the unmodelled-expression fallback below does -- printed the
				// body's statements in the ENCLOSING function: `auto g = [](int x) { return x; };` emitted a
				// bare outer `return x;`.
				const entry = this.buildFunctionBody(recurse, paramSlotsOf(e.params), [e.body]);
				entry.expr = e;
				this.expnodes.set(e, entry);
				this.end = entry;
				// The lambda's text still prints verbatim, so a name only IT mentions -- a capture that the
				// body never reads, a parameter default -- needs a reader of its own or the declaration it
				// depends on is elided as dead.
				for (const c of e.captures) {
					if (c.init)
						recurse.expression(c.init);
					if (c.name)
						this.readOnly(Common.Identifier(c.name));
				}
				for (const p of e.params)
					if (!isPackParameter(p) && p.default)
						recurse.expression(p.default);
				return false;
			}

			case 'conditional': {
				process(e);
				const node = this.makeExprNode(e);
				connectValue(this.getExprNode(e.test), 0, node, 0);
				connectValue(this.getExprNode(e.consequent), 0, node, 1);
				connectValue(this.getExprNode(e.alternate), 0, node, 2);
				return false;
			}

			case 'index': {
				process(e);
				const node = this.makeExprNode(e);
				node.freshTarget = true;
				connectValue(this.getExprNode(e.object), 0, node, 0);
				connectValue(this.getExprNode(e.index), 0, node, 1);
				return false;
			}

			case 'member':
			case 'pointer_member': {
				// One tag for both: `.` and `->` differ only in the operator, which is the stamp. The
				// whole expr isn't kept (unlike py's index), so `pointer_member` is recorded on the node.
				process(e);
				const node = this.makeNode({ type: 'member', name: e.property });
				if (e.type === 'pointer_member')
					node.pointerMember = true;
				node.freshTarget = true;
				this.expnodes.set(e, node);
				connectValue(this.getExprNode(e.object), 0, node, 0);
				return false;
			}

			case 'cast': {
				// `(T)x`: pure, with the cast's own type kept in the payload and the operand threaded.
				process(e);
				connectValue(this.getExprNode(e.expression), 0, this.makeExprNode(e), 0);
				return false;
			}

			case 'call': {
				// Same convention as TS/PY: a callee named `pure...` is the placeholder for real purity
				// analysis; every other call is an effect and threads the state chain.
				process(e);
				const pure = e.callee.type === 'identifier' && e.callee.name.startsWith('pure');
				const node = pure ? this.makeExprNode(e) : this.makeExprNode(e, 'effect');
				if (!pure)
					this.connectEnd(node);
				e.arguments.forEach((arg, i) => connectValue(this.getExprNode(arg), 0, node, i + 1));
				connectValue(this.getExprNode(e.callee), 0, node, e.arguments.length + 1);
				return false;
			}
		}

		// An expression form this dialect doesn't model (`new`/`delete`/a lambda/`cpp_cast`/...): the
		// only safe assumption about a value whose evaluation order and purity are unknown is that it
		// is an effect, which is also what keeps it printed verbatim, in place.
		console.log(`not handling expression ${(e as {type: string}).type}`);
		process(e);
		this.connectEnd(this.makeExprNode(e, 'effect'));
		return false;
	}
}

// ===================================================================
//  Reconstruction
// ===================================================================

export class CPPEmitter extends Emitter<Expr, TopLevel, Spec> {
	constructor(graph: VSDG, blocks?: BlockTree, blockIds?: Map<NodeId, string>) {
		super(graph, cppDialect, blocks, blockIds);
	}

	// ---- statement constructors ----
	// A C++ body is ONE statement (a `Block` when the source braced it), so the arrays the core hands
	// over get wrapped -- the other way round from py, whose bodies ARE arrays.

	makeBlock(body: TopLevel[] | undefined): Stmt | undefined {
		// A body slot never holds a definition; the cast is that contract, not a guess.
		return body === undefined ? undefined : Common.Block<Stmt>(...(body as Stmt[]));
	}
	private declaration(name: string, specifiers: Spec, value: Expr): TopLevel {
		return {
			type: 'declaration',
			specifiers,
			initDeclarators: [{ declarator: Common.Identifier(name), initializer: value }],
		} as TopLevel;
	}

	makeSwitch(discriminant: Expr, cases: { test?: Expr, consequent: TopLevel[] }[]): TopLevel {
		const body: TopLevel[] = [];
		// Labels still waiting for a body: `case 1: case 2: g();` is a label whose own body IS the next
		// label, so an empty case chains onto whatever follows instead of printing a `case 1: ;`.
		let open: Stmt[] = [];
		const close = (label: Stmt): Stmt => {
			let node: TopLevel = label;
			for (let i = open.length; i-- > 0;)
				node = { ...open[i], body: node } as Stmt;
			open = [];
			return node as Stmt;
		};

		for (const c of cases) {
			const label = (c.test ? { type: 'case', test: c.test } : { type: 'default' }) as unknown as Stmt;
			if (c.consequent.length === 0) {
				open.push(label);
				continue;
			}
			// C++ forbids jumping past a declaration's initialisation into its scope: without a block,
			// `case 1: int y = 1; break; case 2:` is ill-formed, since case 2's jump enters y's scope.
			if (c.consequent.some(st => (st as { type?: string }).type === 'declaration')) {
				body.push(close({ ...label, body: Common.Block<TopLevel>(...c.consequent) } as unknown as Stmt));
				continue;
			}
			const [first, ...rest] = c.consequent;
			body.push(close({ ...label, body: first } as unknown as Stmt), ...rest);
		}
		// A trailing empty case has nothing to chain onto; it still needs a statement to print.
		for (const label of open)
			body.push({ ...label, body: { type: 'empty' } } as unknown as Stmt);

		return { type: 'switch', discriminant, body: Common.Block<TopLevel>(...body) } as unknown as TopLevel;
	}
	makeTry(): TopLevel									{ throw new Error('vsdg/cpp: try is printed verbatim'); }
	makeThrow(argument: Expr): TopLevel					{ return { type: 'throw', argument }; }
	// C++ spells a temporary as `auto t0 = value;` -- there is no keyword-less declaration form.
	makeTempDecl(name: string, value: Expr): TopLevel	{ return this.declaration(name, { type: C.RefType('auto') }, value); }

	// ---- whole statements the core anchors on ----

	emitPassthru(node: NOf<'passthru'>): TopLevel {
		return node.stmt;
	}
	rebuildClassDecl(node: NOf<'class_decl'>): TopLevel {
		// A class is never modelled here -- its declaration stays a passthru -- so this is only reached
		// if some future lowering starts creating class_decl nodes.
		return node.stmt;
	}
	rebuildFunctionDecl(node: NOf<'function'>, body: TopLevel[]): TopLevel {
		return { ...(node.stmt as FunctionDef), body: this.makeBlock(body) } as TopLevel;
	}

	// A `var` node prints as a declaration when it carries the type the source declared it with, and as
	// a plain assignment when it doesn't (a binding created by an assignment to a name declared
	// elsewhere -- see the builder's own `lowerAssign`).
	emitNamedSlot(name: string, node: N): TopLevel | undefined {
		this.names.add(name);

		if (node.type === 'var') {
			// An external name (a global, a built-in, or a name a verbatim statement declared) has no
			// initializer of its own to print -- it's resolved by name wherever it's read.
			if (!node.inputs[0])
				return undefined;
			if (!this.graph.hasRealConsumer(node) && !this.nameStoredTo(name, node.id))
				return undefined;
			const value = this.resolveOperand(node.id, 0);
			return node.typeAnnotation !== undefined
				? this.declaration(name, node.typeAnnotation, value)
				: Common.ExprStmt(Common.Assign(Common.Identifier(name), value));
		}
		if (node.type === 'mutation')
			return this.rebuildMutationStatement(node);
		return Common.ExprStmt(Common.Assign(Common.Identifier(name), this.buildExpr(node)));
	}

	// True when anything else in the program still names this variable as a STORE TARGET -- either a
	// node that currently binds it (`x = 2` merged into a ternary) or a mutation whose own target is
	// that name. C++ has no implicit declaration, so the declaration has to survive even when nothing
	// reads its VALUE: `int x = 1; if (c) { x = 2; } else { x = 3; }` prints `return c ? x = 2 : (x = 3);`,
	// and `if (0)` would print `return x = 3;` -- a name with no declaration at all. A scan rather than
		// a slotName() lookup because folding a constant branch bypasses the gammaValue that held the name,
		// leaving only the store. (`hasForcedSibling` would miss both: such a store is never forcedPrint.)
		// A PARAMETER never matches: it is never bound and the signature already declares it.
	private nameStoredTo(name: string, excludeId: NodeId): boolean {
		for (const other of this.graph.values()) {
			if (other.id === excludeId)
				continue;
			if (slotName(other) === name)
				return true;
			const target = other.type === 'mutation' ? (other.expr as unknown as { target?: Expr }).target : undefined;
			if (target?.type === 'identifier' && target.name === name)
				return true;
		}
		return false;
	}

	// ---- expressions ----

	rebuildPayload(node: N): Expr {
		switch (node.type) {
			case 'floating':	return this.rebuildFloating(node as NOf<'floating'>);
			case 'mutation':	return this.rebuildMutationValue(node as NOf<'mutation'>);
			case 'effect':		return this.rebuildEffect(node as NOf<'effect'>);
			case 'member': {
				const object = this.resolveOperand(node.id, 0);
				return node.pointerMember
					? { type: 'pointer_member', object, property: node.name } as Expr
					: Common.Member(object, node.name);
			}
		}
		console.log(`not handling value node ${node.type}`);
		return Common.Literal(0);
	}

	private rebuildFloating(node: NOf<'floating'>): Expr {
		const e = node.expr;
		switch (e.type) {
			case 'identifier':
			case 'literal':
			case 'char_literal':
			case 'sizeof_type':
			case 'null_literal':
			case 'this':
			case 'qualified':
				return e;	// leaf: nothing in the graph to put back, the payload prints as-is
			case 'unary':
				return { ...e, operand: this.resolveOperand(node.id, 0) };
			case 'binary':
				return { ...e, left: this.resolveOperand(node.id, 0), right: this.resolveOperand(node.id, 1) };
			case 'conditional':
				return this.buildConditional(node);
			case 'index':
				return { ...e, object: this.resolveOperand(node.id, 0), index: this.resolveOperand(node.id, 1) };
			case 'cast':
				return { ...e, expression: this.resolveOperand(node.id, 0) };
		}
		console.log(`not handling value node ${(e as {type: string}).type}`);
		return Common.Literal(0);
	}

	private rebuildMutationValue(node: NOf<'mutation'>): Expr {
		const e = node.expr as Common.Assign<Expr, C.assignableOps>;
		return Common.Assign(this.resolveTarget(node.id, 0), this.resolveOperand(node.id, 1), e.operator);
	}

	rebuildMutationStatement(node: NOf<'mutation'>): TopLevel {
		return Common.ExprStmt(this.rebuildMutationValue(node));
	}

	private rebuildEffect(node: NOf<'effect'>): Expr {
		const e = node.expr;
		if (e.type === 'call') {
			// The callee is normally left raw; only a callee that embeds a real effect (or was hoisted
			// into a temp) has to be resolved, or printing the raw source would duplicate its execution.
			const calleeEdge	= node.inputs[e.arguments.length + 1];
			const calleeNode	= calleeEdge && this.graph.get(calleeEdge.nodeId);
			const calleeTemp	= calleeNode && this.nodeVariableNames.get(calleeNode.id);
			const callee		= calleeTemp
				? Common.Identifier(calleeTemp)
				: calleeNode && !this.graph.isPureSubgraph(calleeNode) ? this.resolveNode(calleeNode.id) : e.callee;
			return { ...e, callee, arguments: e.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
		}
		return e;	// `new`/`delete`/a lambda/an unmodelled construct, kept verbatim
	}
}

// ===================================================================
//  The pipeline
// ===================================================================

export function BuildVSDG(ast: readonly Definition[]): VSDG {
	const builder = new CPPBuilder();
	builder.build(ast);
	return builder.finish();
}

export function Optimize(graph: VSDG): void {
	optimize(graph, cppDialect);
}

export function BuildProgram(
	graph:		VSDG,
	blocks?:	BlockTree,
	blockIds?:	Map<NodeId, string>
): TopLevel[] {
	return new CPPEmitter(graph, blocks, blockIds).build();
}

// Kept for callers that drive CSE directly; `Optimize` runs it as its own final round.
export function optimizeStructuralCSE(graph: VSDG, protectedIds: Set<NodeId>): boolean {
	return structuralCSE(graph, cppDialect, protectedIds);
}
