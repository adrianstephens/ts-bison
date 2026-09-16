/* eslint-disable @typescript-eslint/no-this-alias */

// ===================================================================
//  The language-neutral VSDG middle end.
// ===================================================================
// BuildVSDG -> Optimize -> applyGlobalCodeMotion -> BuildProgram, over ANY of the three
// converged ASTs (TS/js-parser, PY/py-parser, CPP/cpp-parser). Everything in this file is
// either pure graph machinery (nodes, edges, scopes, mu/theta/gamma, GCM, CSE, folding) or a
// question asked of a `Dialect`.
//
// A language supplies three things, one job each -- the first and last are interfaces this file names,
// the middle one it never does: how an AST is walked is that language's own business, and the core
// only ever sees the `Recurse` it is handed.
//
//   * `Dialect`	 -- FACTS about the language that the core asks about (how to spell a name,
//					  what a literal is, which operators fold, what is unsafe to CSE). Stateless
//					  and reachable from the graph (`graph.dialect`), because the optimiser and the
//					  emitter hold only a graph;
//   * LOWERING	 -- this language's own `walkerB` (how its AST nests) plus one callback per
//					  statement/expression tag, wired up and driven by that language alone
//					  (`TSBuilder.walkerB()` + its own `BuildVSDG`). NO INTERFACE: the core never walks an
//					  AST, so it never names any of it -- see `Recurse` for the one part it does name. The
//					  callbacks are methods on that language's `VSDGBuilder` subclass, whose base supplies
//					  the run's state and the primitives they write against (makeNode/connectEnd/
//					  rebindVar/bindVar/buildLoop/walkBranch/mergeState/reconcileVariables/buildFunctionBody/
//					  lowerVerbatim). They DRIVE those primitives in an order they choose, which is why
//					  they can't be abstract members the way `Emitter`'s are -- and why the walker stays
//					  the language's own object: the primitives that must reach it lazily
//					  (buildLoop/buildFunctionBody/buildClass) take it as a parameter, so a builder is
//					  built from nothing but a `Dialect` and never points back at the walker driving it;
//   * `Emitter`	 -- RECONSTRUCTION: graph nodes back onto this language's AST, plus that AST's
//					  statement constructors. Each language already has a printer for its own AST,
//					  so an emitter only ever rebuilds nodes, never source text.
//
// What it does NOT supply: any knowledge of `floating`/`mutation`/`effect`/`member` payload
// shapes. Instead, the language STAMPS the few shape facts the core genuinely needs onto the node
// when it creates it -- `plainAssign` (a mutation whose port 0 is the never-read old value),
// `freshTarget` (an lvalue address that must always rebuild). That is the same idiom as the
// pre-existing `switchInternal`/`scopeAnchorId`/`capturedRead` stamps, and it is what keeps
// `RawNode`'s own methods language-free. Whether an expression is a CONSTANT is deliberately NOT one
// of them: that is a fact about this language's own literal forms, so the dialect answers it.
//
// Generics: E = expression, S = statement, T = type annotation. `B` (a fourth parameter every node
// and scope still carries) is now unused -- see ParamSlot for where its destructuring job went.

import { Identifier, Literal, Unary, Binary, Conditional, Assign, If, While, DoWhile, Return, ExprStmt } from './common';

// ===================================================================
//  Node model
// ===================================================================

export type NodeId = string;

export interface Edge {
	nodeId:	NodeId;
	port:	number; 
}
export interface ClassMember {
	keyNodeId?:		NodeId;
	entryNodeId?:	NodeId;
	valueNodeId?:	NodeId;
}
export interface ClassInfo {
	superClassNodeId?: NodeId;
	members: ClassMember[];
}

// What a node fundamentally IS: its tag plus the one payload that tag carries -- an AST expression
// (floating/mutation/unary_post/effect/a function EXPRESSION), a raw statement (passthru/class_decl/a
// function DECLARATION), or a slot name (var/muValue/thetaValue/member/named-except/a marker's tag).
// A literal has no tag of its own on any of the three ASTs: it's a 'floating' node whose own expr is
// whatever that language calls a literal. `.expr` is mutated in place once -- foldConstants folds a
// binary/unary into a literal, a same-payload-shape transition.
//
// Payload types are the only per-language part: E for expressions, S for raw statements, T for a
// declaration's type annotation.
export interface SwitchCase { testNodeId?: NodeId; boundaryId: NodeId; tailId: NodeId }

// Internal bookkeeping / state-chain anchor nodes -- a 'marker' node's whole payload.
export type MarkerName =
	| 'PROGRAM_START' | 'FUNCTION_BODY_START' | 'RETURN_ANCHOR' | 'MUTATION_MARKER'
	| 'EARLY_RETURN_MARKER' | 'THROW_MARKER' | 'BREAK_MARKER' | 'CONTINUE_MARKER'
	| 'TRY_START' | 'CATCH_START' | 'FINALLY_START' | 'BREAK_SCOPE_START';

export type INode<E, S, T> =
	| { type: 'gamma' }
	// `name` is the variable this merge is the value of -- its only identity, and never cleared.
	// neverMaterialize: a broken-out merge whose operand still resolves to its OWN name would print a
	// circular `name = op0 ? name : name;` -- forces it to always resolve lazily instead.
	| { type: 'gammaValue', name: string, neverMaterialize?: boolean }
	// loopKind: a do-while's state mu -- the body runs before the first test, so no loop-rotation.
	| { type: 'mu', loopKind?: 'do' }
	| { type: 'muValue', name: string }
	| { type: 'theta' }
	| { type: 'thetaValue', name: string }
	// declKind + (paired) typeAnnotation: a var_decl wrapper node -- a param is a declKind-less 'var',
	// and isInlinableVarDecl/resolveNode/hasOrderedInputs/needsDirectPlacement all test for exactly
	// that. The annotation is threaded through every reconstruction so an explicitly-typed
	// empty-collection literal doesn't lose its type.
	| { type: 'var', name: string, declKind?: string, typeAnnotation?: T, capturedRead?: boolean }
	// switchDiscriminantId/switchCases: a `break_scope` reconstructing a real `switch` -- the
	// discriminant node, and each case's resolved test + body span (see SwitchCase). A language with
	// no switch construct never creates one.
	| { type: 'break_scope', switchDiscriminantId?: NodeId, switchCases?: SwitchCase[] }
	// catchParam: the catch clause's binding name, for reconstructing `catch (e) {...}`.
	// handlerTypeNodeId: the exception TYPE the clause matches (`except ValueError`), for a language
	// whose handler can be typed. A side channel like switchDiscriminantId -- see
	// collectProtectedNodeIds's own comment on why it must not be CSE-merged away.
	| { type: 'except', catchParam?: string, handlerTypeNodeId?: NodeId }
	// A per-variable try/catch value merge -- mirrors gammaValue (`name` alone carries its
	// identity), except neither branch's binding is ever cleared to make way for it (see the
	// 'try' case's own comment): there's no printable condition for a ternary here.
	| { type: 'exceptValue', name: string }
	// One entry/RETURN_ANCHOR-pair subgraph -- a declaration (stmt set), a method (neither set), or a
	// function/arrow/lambda EXPRESSION (expr set, prints inline like an effect). returnNodeId is the
	// only way to reach the RETURN_ANCHOR (no ordinary edge connects entry to return).
	// destructuredParams: a language's own token for a param it bound through a hidden temp (js/ts
	// destructuring), mapped to that temp's name -- so the printed SIGNATURE can name the temp too,
	// not just the desugared body. The key is opaque to the core; see ParamSlot.
	| { type: 'function', stmt?: S, expr?: E, returnNodeId: NodeId, destructuredParams?: Map<unknown, string> }
	| { type: 'class_decl', stmt: S }
	| { type: 'passthru', stmt: S }
	| { type: 'marker', name: MarkerName }
	// mutatesBindingId: set when the dialect knows this expression does NOTHING but rewrite the name whose
	// new binding is that node -- C++'s `x++`/`--x` on a plain name (see its own lowering for the
	// assumption behind that). Everything else about an effect is unknowable from here, so the core uses
	// this for one thing only: dropping a wholly dead one. With the value unused and nothing reading the
	// binding, the write is a store to a name nobody reads, which is dead by the same rule `x = 1;` is.
	| { type: 'effect', expr: E, mutatesBindingId?: NodeId }
	// optional: a `?.` member access (`.name` is the field; unlike 'index', which keeps the whole
	// expr) -- without it `a.b?.c` reconstructs as `a.b.c`.
	// pointerMember: C++'s `a->b`, which dereferences -- a different operation with the same shape, so
	// without it `a->b` reconstructs as `a.b`. Both are the operator part of the same member access,
	// which is why they're stamps here rather than distinct tags (see the file header).
	| { type: 'member', name: string, optional?: boolean, pointerMember?: boolean }
	| { type: 'unary_post', expr: E, name?: string }
	| { type: 'unary_post_old', expr: E }
	| { type: 'floating', expr: E }
	// name: set while this assignment is the current binding of that variable (see rebindVar) -- a
	// mutation has no declared name of its own, unlike a var_decl.
	| { type: 'mutation', expr: E, name?: string }
	;

export type NodeType = INode<any, any, any>['type'];
// The graph's value type, `any` payloads deliberately: the core reads variant payloads off nodes it
// fetches (narrowing the tag needs a UNION), and an erased node must fit a `Node<E, S, T>` parameter.
type NodeAny = Node<any, any, any>;

// The edge machinery every node has, plus the optional annotations the passes stamp on that span
// several tags. Tag-local annotations live on the matching INode variant instead.
export class RawNode {
	// Assigned by MakeNode from the INode variant this is Object.assign'd with (there are no
	// subclasses). The tag UNION, not `string`, so a mistyped case label below is still an error.
	type!:			NodeType;
	inputs:			Edge[]		= [];		// inputs[port] = the single source edge feeding this slot
	outputs:		Edge[][]	= [];		// outputs[port] = every downstream edge consuming this channel
	// Set while this node is the current binding of its own variant's `name` (a var_decl/reassignment,
	// or a per-variable merge); CLEARED when a branch's reassignment is superseded by a merge.
	bound?:			boolean;
	forcedPrint?:	boolean;				// Forces a reassignment to print even with no value-consumer: one on an exited branch (break/continue/return) skips the post-branch merge entirely, so needsTemp would see it as dead.
	// Marks switch's own internal bookkeeping (`__hit`/`__matchN`) as always resolved by name --
	// without this it's indistinguishable from an ordinary reassignment, whose inlining legitimately
	// depends on forcedPrint/needsTemp. Set on a gamma AND on the `hit` var/mutation.
	switchInternal?: boolean;
	// A 'this'/'super' node's enclosing function id -- unlike a param (a real graph edge), it has no
	// input to float a hoisted, loop-invariant read against, so without this it can escape the
	// class/function it belongs to entirely.
	scopeAnchorId?: NodeId;
	exported?:		'named' | 'default';	// Stamped on whatever node an export left behind, so its own print site can wrap it in `export `/`export default `.
	classInfo?:		ClassInfo;				// A class anchor's own resolved pieces -- index-aligned with the original `body` array; rebuildClass splices these back in. Set on a class_decl statement AND on the effect node of a class expression.

	// ---- shape stamps, set by the language when it creates the node (see the file header) ----
	plainAssign?:	boolean;				// A 'mutation' from a plain `=` (no compound operator), whose port 0 is the never-read old value
	freshTarget?:	boolean;				// A 'member'/index-shaped lvalue address: must always rebuild, never resolve to a cached temp
	// Set on every node created while lowering a statement that will be PRINTED VERBATIM (a
	// passthru -- see lowerVerbatim). Those nodes exist only so a name the verbatim text mentions
	// keeps a real reader and isn't elided as dead; the text itself already says what to do, so
	// emitting any of them would run the statement's insides a second time.
	suppressed?:	boolean;

	constructor(public id: string) {}
	outDegree() { return this.outputs.reduce((sum, arr) => sum + arr.length, 0); }

	// True when an edge into this node at `port` is wired up generically but never actually read by
	// codegen, so it must not count as a real reader for reuse/dead/inline decisions or constrain GCM
	// scheduling like an ordinary dependency.
	isVestigialEdge(port: number): boolean {
		switch (this.type) {
			// The assignment-operator's own "old value" port (0) is never read by codegen (the mutation's
			// own rebuild only resolves the right-hand side for a plain `=`); threadMutation's own
			// ordering-only marker edge (port 2) would otherwise make isPureSubgraph wrongly call it impure.
			case 'mutation':	return port === 2 || (!!this.plainAssign && port === 0);
			// A named theta's own condition edge -- resolveNode always resolves a thetaValue through
			// its mu source (port 1) instead.
			case 'thetaValue':	return port === 0;
			// A postfix ++/--'s old-value snapshot (port 1, see the dialect's own lowering): real for
			// SCHEDULING (the snapshot must be read before the increment, `isSchedulingRelevant`), never
			// a value either node reads -- counting it would materialise a snapshot nothing consumes.
			case 'unary_post':	return port === 1;
			// Same ordering-only marker edge as 'mutation', see above.
			case 'var':			return port === 2;
			// A state gamma's tail ports (2/3): Output's emitChain walks these directly to find where
			// each branch's content starts, never through resolveOperand. A switchInternal gamma's own
			// condition (port 1) is bypassed too -- switch's own case-cascade reconstruction never reads it.
			case 'gamma':		return port === 2 || port === 3 || (port === 1 && !!this.switchInternal);
			// A break_scope's tail port (1) -- same reasoning as gamma's.
			case 'break_scope': return port === 1;
			// The state except's own try/catch/finally tails (1/2/3) -- same reasoning. exceptValue's
			// own ports (0/1) are never visited this way in the first place (no case needed for it,
			// defaults false, same as gammaValue).
			case 'except':		return port === 1 || port === 2 || port === 3;
			default:			return false;
		}
	}
}

// A concrete node: RawNode's edge machinery + annotations, plus one INode variant's own payload.
export type Node<E, S, T, N extends INode<E, S, T> = INode<E, S, T>> = RawNode & N;
// The node for one specific tag, with that variant's own annotations -- what makeNode/MakeNode hand back.
export type NodeOf<E, S, T, K extends NodeType> = Node<E, S, T, Extract<INode<E, S, T>, { type: K }>>;

export function MakeNode<E, S, T, N extends INode<E, S, T>>(id: string, inode: N): NodeOf<E, S, T, N['type']> {
	return Object.assign(new RawNode(id), inode) as unknown as NodeOf<E, S, T, N['type']>;
}

/**
 * A node's real source-variable name, if this node is CURRENTLY that binding -- a direct rebind or a
 * per-variable merge. The ONE place `bound` and a variant's own `name` are read together, and a free
 * function rather than a `RawNode` method because the name is tag-local: `RawNode` has none to read
 * (and must not -- `member`/`marker` spell a `name` of their own, meaning something else entirely).
 */
export function slotName<E, S, T>(node: Node<E, S, T>): string | undefined {
	switch (node.type) {
		// A merge IS its own name, and is never cleared (see reconcileVariables's own exclusions),
		// so there is no flag to consult.
		case 'gammaValue':
		case 'exceptValue':	return node.name;
		// Every tag a binding can actually be cleared from -- a declaration, a rebind (assignment or
		// prefix ++/--), a postfix ++/--. MUST stay the same set as rebindVar's own guard below.
		case 'var':
		case 'mutation':
		case 'unary_post':	return node.bound ? node.name : undefined;
		// muValue/thetaValue carry a name too, but resolveNode's own cases trust them by name where
		// they're read -- neither is ever printed under it.
		default:			return undefined;
	}
}

export function connectValue(
	from:	RawNode, outputPort: number,
	to:		RawNode, inputPort: number
): void {
	to.inputs[inputPort] = { nodeId: from.id, port: outputPort };
	(from.outputs[outputPort] ??= []).push({ nodeId: to.id, port: inputPort });
}

// INVARIANT for any "scheduling-only" edge (one added purely to influence GCM's placement of `to`,
// not read by codegen): `from` must be a genuine STRUCTURAL lower bound on `to`'s depth, never
// merely incidental -- scheduleEarly treats it as an ordinary dependency, so an incidental `from`
// can drag an unconditional statement inside a conditional it doesn't belong in.

// ===================================================================
//  Scopes
// ===================================================================

export class Scope<E, S, T> {
	local		= new Set<string>;
	bindings	= new Map<string, Node<E, S, T>>();
	// Set only on a function's own scope (never an ordinary if/while/etc body) -- distinguishes an
	// ordinary local reassignment from one that crosses into an enclosing function (needs
	// forcedPrint, see isLocalToCurrentFunction).
	isFunctionBoundary = false;

	constructor(public parent: Scope<E, S, T> | null = null) { }
	closeAndFlush() {
		if (this.parent) {
			for (const [name, node] of this.bindings.entries()) {
				if (!this.local.has(name))
					this.parent.bindings.set(name, node);
			}
		}
		return this.parent;
	}
	create(name: string, node: Node<E, S, T>): void {
		this.local.add(name);
		this.bindings.set(name, node);
	}
	set(name: string, node: Node<E, S, T>): void {
		this.bindings.set(name, node);
	}
	get(name: string): Node<E, S, T> | undefined {
		return this.bindings.get(name) ?? this.parent?.get(name);
	}

	// False means `name` is captured from outside the current function -- reassigning it is an
	// effect that escapes this function, so it can't be safely inlined based on a same-region
	// consumer count (the real consumer may be an as-yet-unrun caller).
	isLocalToCurrentFunction(name: string): boolean {
		for (let s: Scope<E, S, T> | null = this; s; s = s.parent) {
			if (s.local.has(name))
				return true;
			if (s.isFunctionBoundary)
				return false;
		}
		return true;
	}

}

export class ScopeMu<E, S, T> extends Scope<E, S, T> {
	muNodes = new Map<string, Node<E, S, T>>();

	// stateAnchor gives a named mu a real scheduling dependency on the loop -- without it, GCM would
	// treat anything depending on the mu as loop-invariant and float it out before the loop entirely.
	// currentFunctionEntry is a live getter, not a captured value: a name looked up from a further
	// nested function needs THAT function's entry, not whichever was current at construction.
	constructor(parent: Scope<E, S, T>, public makeMu: (name: string) => Node<E, S, T>, public stateAnchor: Node<E, S, T>, public currentFunctionEntry: () => Node<E, S, T> | undefined) {
		super(parent);
	}
	public get(name: string): Node<E, S, T> | undefined {
		const node = this.bindings.get(name);
		if (node)
			return node;
		const old = this.parent?.get(name);
		if (old) {
			const mu = this.makeMu(name);
			// A captured (outer-scope) read touched inside a loop needs the same scopeAnchorId floor
			// this/super get: without it, a value purely derived from this mu can be hoisted (loop-
			// invariant) past the arrow/function it's lexically inside, into an enclosing scope that
			// never reads it (a verbatim-printed arrow body is oblivious to anything GCM decided).
			mu.scopeAnchorId = this.currentFunctionEntry()?.id;
			this.muNodes.set(name, mu);					//original mu
			this.bindings.set(name, mu);				// current node
			connectValue(old, 0, mu, 0);				// Slot 0 = Initial value from outside
			connectValue(this.stateAnchor, 0, mu, 2);	// Slot 2 = scheduling-only: "at least as deep as the loop"
			return mu;
		}
	}
}

export class VSDG extends Map<NodeId, NodeAny> {
	root: NodeId = '';

	constructor() { super(); }

	getNode(id: NodeId) {
		const node = this.get(id);
		if (!node)
			throw new Error(`missing node ${id}`);
		return node;
	}

	removeInputs(node: RawNode) {
		for (const e of node.inputs) {
			const down = this.getNode(e.nodeId);
			down.outputs[e.port] = down.outputs[e.port].filter(c => c.nodeId !== node.id);
		}
		// Clears node's OWN inputs too, not just the producers' outputs -- harmless for printing, but
		// a later pass that walks every node's inputs unconditionally (scheduleEarly) would otherwise
		// crash once the now-unreferenced producer is removed by a later CSE pass.
		node.inputs = [];
	}
	removeNode(node: RawNode) {
		this.removeInputs(node);
		this.delete(node.id);
	}

	// True if `node`'s own value has at least one real reader, beyond whatever vestigial edges exist.
	// Zero means it's genuinely dead -- e.g. every branch unconditionally reassigns a variable before
	// anything reads its declared value.
	hasRealConsumer(node: RawNode): boolean {
		return (node.outputs[0] ?? []).some(e => !this.get(e.nodeId)!.isVestigialEdge(e.port));
	}
	// Conservative, single-pass purity check over `node`'s own transitive inputs: true only if NO
	// effect appears anywhere in the subgraph that produces it.
	isPureSubgraph(node: RawNode): boolean {
		const seen		= new Set<NodeId>();
		const recurse	= (node: RawNode): boolean => {
			if (seen.has(node.id))
				return true;
			seen.add(node.id);
			if (node.type === 'effect' || node.type === 'marker')
				return false;
			// A function/method entry node has NO input edges (deliberately disconnected from the outer
			// state chain) -- without this check, an empty `.every(...)` is vacuously "pure", wrongly
			// inlining the entry node itself in place of a param's own value.
			if (node.type === 'function')
				return false;
			// A PARAMETER's own value is always pure regardless of what's behind it -- recursing past it
			// into the entry node would poison every computation that merely reads a param's value based
			// on whatever runs before this function is even called. A param's input comes from a real
			// entry OUTPUT port (>= 1); port 0 would be `const f = () => {}` reading the function itself.
			if (node.type === 'var' && node.inputs[0]?.port !== undefined && node.inputs[0].port >= 1
				&& this.get(node.inputs[0].nodeId)!.type === 'function')
				return true;
			// Skip vestigial edges (e.g. threadMutation's own scheduling-only marker) -- a real graph
			// edge GCM needs, but never part of the actual value computation.
			return node.inputs.every((e, port) => !e || node.isVestigialEdge(port) || recurse(this.get(e.nodeId)!));
		};
		return recurse(node);
	}

}

// ===================================================================
//  The dialect seam
// ===================================================================

// A language's own walker, narrowed to the subset the core and every lowering handler need -- what a
// language's `walkerB` builds and that language's own `BuildVSDG` then drives. Each language's own
// `WalkerB` recurse satisfies it structurally.
//
// This is the ONLY part of a walk the core names: it DRIVES a subtree, and never handles a single node.
// The per-node callbacks a language dispatches to are its own business; `recurse.statement(s)` is not
// one of them but COMPOSES one with the grammar's descent, which is why the two aren't the same thing.
// (The walker must exist before the first statement is lowered: lowering a function body walks
// statements the callback currently running isn't standing on.)
export interface Recurse<E, S> {
	statement(s?: S): boolean;
	expression(e?: E): boolean;
	statements(x: readonly S[]): boolean;
}

// One parameter position in the neutral form `buildFunctionBody` binds. A plain name gets its own
// 'var' node on the entry's next output port. Any other shape -- js/ts destructuring is the only one
// across the three ASTs -- gets a HIDDEN temp instead, and the slot carries the step that finishes
// binding it off that temp. That step is a closure rather than a `Dialect` question on purpose:
// turning a pattern into statements WALKS, and calls back into the builder while doing it, which is
// LOWERING -- `Dialect` answers FACTS only. `token` is whatever the language wants to recognise that
// parameter by afterwards (it comes back through the function node's own `destructuredParams`); the
// core never reads it.
export type ParamSlot = { name: string } | { token: unknown, desugar: (tempName: string) => void };

/**
 * A language's own spelling of `switch`'s fixed scaffolding -- the only parts of that desugar which
 * are not the same shape everywhere. The WALK is the core's (`buildSwitch`), including the per-case
 * scope a declaration inside a case needs, so a language supplies four one-liners and nothing else.
 * Named in a type position the core uses, which is the test for belonging in this file.
 */
export interface SwitchSyntax<E, S, T> {
	/**
	 * A hidden local bound to `value` and carrying `name`, which the core supplies (`__disc_<n>`,
	 * `__match0_<n>`, `__hit_<n>`) and reads back off the returned node. `n` must be unique per switch,
	 * which is all two switches in one scope need.
	 */
	local(value: E, name: string): NodeOf<E, S, T, 'var'>;
	/** `<discName>` tested against a case's own test: `===` in js, `==` in C++, ... */
	comparison(discName: string, test: E): E;
	/** "this case runs": `<hit> || <match>`, or -- for `default` -- "none of the others matched". */
	condition(hitName: string, matchName: string | undefined, otherMatches: string[]): E;
	/** `<hit> = true`, as an expression this language's own assignment lowering walks. */
	setHit(hitName: string): E;
}

// FACTS about a language that the core asks about, and nothing else: no walker, no lowering, no
// reconstruction (the lowering half owns the first two, `Emitter` the third). Kept deliberately small: a
// deeper question would be the core learning AST shapes it has no business knowing, so it is a
// stamp on the node instead (see the file header). The graph carries one, which is how the free
// optimiser passes reach it without being handed a builder or an emitter.
export interface Dialect<E, S, T> {
	/** The name a bare identifier reference binds to, or undefined for any other expression shape. */
	identifierName(e: E): string | undefined;
	/** This language's own node for a bare name reference. */
	identifier(name: string): E;
	/** This language's literal form for `value`. */
	literal(value: unknown): E;
	/**
	 * The value that literal form carries, or undefined for any expression that isn't one of this
	 * language's literals -- the inverse of `literal(value)`, and the ONE thing that decides whether
	 * the core may treat a node as a constant. A form that merely LOOKS literal answers undefined here:
	 * C++'s `'a'`/`nullptr` (folding `'a' + 1` would be JS's string concatenation, not C++'s integer
	 * arithmetic), python's f-strings (a literal with interpolation holes in it).
	 */
	literalValue(e: E): unknown;
	/**
	 * True when a constant value (`literalValue`'s own answer) counts as true -- what a constant
	 * CONDITION means in this language, and not derivable from `!!`: the value is the dialect's own to
	 * shape (C++'s carries a type with it, so the object around a zero is always truthy), and a
	 * language whose zero is falsy in a different sense would say so here.
	 */
	truthy(value: unknown): boolean;
	/** True when `e` is the literal `true` -- a loop whose condition is one needs no rotation check. */
	isTrueLiteral(e: E): boolean;
	/** A structural signature for an opaque expression payload, for structural CSE. */
	exprKey(e: E): string;
	/** The same, for a raw statement held verbatim by a passthru/class_decl node. */
	stmtKey(s: S): string;
	/**
	 * True when `node` must never be merged with a structurally identical node: something whose
	 * VALUE differs between two identical-looking occurrences (a fresh array/object identity, a
	 * per-call receiver, an lvalue read that a mutation can change in between).
	 */
	isCSEUnsafe(node: Node<E, S, T>): boolean;
	/** The operand arity this node's payload folds at (1 or 2), or undefined if it isn't foldable. */
	foldable(node: Node<E, S, T>): number;
	/** Folds a foldable node's payload over its operand VALUES, or undefined if it can't be folded. */
	foldValue(node: Node<E, S, T>, operands: unknown[]): unknown | undefined;
	/** True when `port` of `consumer` reads its producer as a call's own CALLEE. */
	isCalleeEdge(consumer: Node<E, S, T>, port: number): boolean;
}

/**
 * True when `node` holds this language's own literal form -- the one question the core asks about
 * constant-ness (see `Dialect.literalValue`). A type predicate, not just a boolean: it already
 * proved which tag carries the payload, so a guarded caller reads `node.expr` directly, and the
 * `node.type` test therefore exists exactly once instead of being repeated by every reader.
 */
function isLiteral<E, S, T>(dialect: Dialect<E, S, T>, node: Node<E, S, T>): node is NodeOf<E, S, T, 'floating'> {
	return node.type === 'floating' && dialect.literalValue(node.expr) !== undefined;
}

// ===================================================================
//  BuildVSDG -- the state machine, shared by every language
// ===================================================================

export interface State<E, S, T> { scope: Scope<E, S, T>, end: Node<E, S, T>, exited: boolean, brokeOut: boolean };

// No abstract members -- `abstract` is a marker only. A language subclasses this to hold the run's
// state, and to call the primitives below from its own lowering handlers.
export abstract class VSDGBuilder<E, S, T> {
	readonly graph: VSDG;
	scope:			Scope<E, S, T>;
	end!:			Node<E, S, T>;
	exited			= false;
	brokeOut		= false;
	/** The innermost function currently being walked (undefined at top level). */
	currentFunctionEntry: Node<E, S, T> | undefined;

	protected nextId	= 0;
	protected expnodes	= new Map<E, Node<E, S, T>>();
	/** Names never declared anywhere in this file (globals, built-ins, imports) -- each gets a single, shared, declKind-less 'var' node so it can be read by name without a declaration. */
	protected externalNodes = new Map<string, Node<E, S, T>>();
	/**
	 * One entry per enclosing LOOP (switch is transparent to `continue`): a for-loop's own `update`
	 * expression, or undefined for while/do-while. `continue` -- lowered onto the same while-shaped
	 * graph while/do-while use -- would otherwise skip `update` entirely, so it re-walks a FRESH
	 * clone of it (the original was already walked once, for the normal path).
	 */
	protected loopUpdateStack: (E | undefined)[] = [];
	/** True only while lowering the inside of a statement that will print verbatim -- see lowerVerbatim. */
	protected verbatim = false;

	constructor(public readonly dialect: Dialect<E, S, T>) {
		this.graph	= new VSDG;
		this.scope	= new Scope(null);	// The global scope
		this.end	= this.makeMarker('PROGRAM_START');
	}

	/** A fresh, graph-unique numeric suffix -- for synthesised names (`__iter0`, `__destructure3`). */
	protected freshId(): number { return this.nextId++; }

	// ---- node construction ----

	makeNode<N extends INode<E, S, T>>(inode: N): NodeOf<E, S, T, N['type']> {
		const id	= inode.type + String(this.nextId++);
		const node	= MakeNode<E, S, T, N>(id, inode);
		node.suppressed = this.verbatim || undefined;
		this.graph.set(id, node as unknown as Node<E, S, T>);
		return node;
	}
	// An internal bookkeeping / state-chain anchor node.
	makeMarker(name: MarkerName): NodeOf<E, S, T, 'marker'> {
		return this.makeNode({ type: 'marker', name });
	}
	/**
	 * 'floating' is the uniform tag for every ordinary, genuinely pure value-producing expression
	 * node; an assignment-operator or ++/-- gets 'mutation' instead, despite possibly sharing the same
	 * AST shape -- both carry a real effect and must never be treated as an ordinary poolable value
	 * (constant-foldable/CSE-mergeable/freely inlinable) the way 'floating' is. Whether the node is a
	 * CONSTANT is the dialect's own `literalValue` answer, not a stamp (see the file header). Registers
	 * the expr so a later getExprNode finds it; the tag is opened up to the full union because a
	 * postfix ++/-- snapshots its old value under 'unary_post_old'.
	 */
	makeExprNode<K extends NodeType = 'floating'>(expr: E, type: K = 'floating' as K): NodeOf<E, S, T, K> {
		const node = this.makeNode({ type, expr } as INode<E, S, T>);
		this.expnodes.set(expr, node);
		return node as unknown as NodeOf<E, S, T, K>;
	}
	getExprNode(expr: E): Node<E, S, T> {
		const name = this.dialect.identifierName(expr);
		if (name !== undefined) {
			const found = this.scope.get(name);
			if (found) {
				// See capturedRead's own comment: a read reaching outside its declaring function must never be statically inlined, since the reading function may run any number of times.
				if (found.type === 'var' && !this.scope.isLocalToCurrentFunction(name))
					found.capturedRead = true;
				return found;
			}
			let ext = this.externalNodes.get(name);
			if (!ext) {
				ext = this.makeNode({type: 'var', name});
				this.externalNodes.set(name, ext);
			}
			return ext;
		}
		const node = this.expnodes.get(expr);
		if (!node)
			throw new Error(`missing node for ${this.dialect.exprKey(expr)}`);
		return node;
	}

	// ---- state ----

	getState(): State<E, S, T> {
		return { scope: this.scope, end: this.end, exited: this.exited, brokeOut: this.brokeOut };
	}
	setState(_scope: Scope<E, S, T>, _end: Node<E, S, T>, _exited = false, _brokeOut = false) {
		this.scope		= _scope;
		this.end		= _end;
		this.exited		= _exited;
		this.brokeOut	= _brokeOut;
	}

	connectEnd(effect: Node<E, S, T>) {
		connectValue(this.end, 0, effect, 0);
		this.end = effect;
	}

	// Walks the state chain backward from `tail` to `boundary`, ignoring MUTATION_MARKER nodes, to
	// check for a REAL effect (a call) -- used to decide whether an if/else branch needs a
	// structural gamma, or whether its value is already fully captured by a per-variable named one.
	hasRealEffect(tail: Node<E, S, T>, boundary: Node<E, S, T>): boolean {
		for (let cur = tail; cur !== boundary; ) {
			if (!(cur.type === 'marker' && cur.name === 'MUTATION_MARKER'))
				return true;
			const pred = cur.inputs[0];
			if (!pred)
				return true; // shouldn't happen; treat conservatively as a real divergence
			cur = this.graph.get(pred.nodeId)!;
		}
		return false;
	}

	// A reassignment is an observable mutation, like a call, but wasn't threaded through the state chain
	// -- without this, a later read of the same binding could be scheduled as if it ran BEFORE the reassignment.
	// Threads a marker into the chain and hangs the node off it via a scheduling-only edge on its own unused port 2 (binary uses 0/1 for real operands, unary uses only 0).
	// (A tighter, per-prior-effect version was tried and reverted: it also constrains scheduling DEPTH, pulling an unconditional reassignment inside a conditional its target effect happened
	// to be nested in -- `if (i) { g(i); } i = i + 1;` became an infinite loop.)
	threadMutation(node: Node<E, S, T>) {
		const marker = this.makeMarker('MUTATION_MARKER');
		connectValue(marker, 0, node, 2);
		this.connectEnd(marker);
	}
	// Binds a node the language ALREADY named when it created it as a NEW declaration in the current
	// scope, and orders it into the state chain. Nothing is being RE-bound, so `rebindVar`'s naming half
	// is left out: the node's own name is what gets published.
	bindVar(node: NodeOf<E, S, T, 'var'>) {
		node.bound = true;
		this.scope.create(node.name, node);
		this.threadMutation(node);
	}
	// The single place a name becomes bound to a node: names it, updates scope, and orders it -- so a
	// call site can't skip one. A declaration whose node already carries its name is `bindVar` instead.
	rebindVar(name: string, node: Node<E, S, T>, isDeclaration = false) {
		// Only these tags hold the name in a field that comes and goes with the binding; a merge
		// (gammaValue/exceptValue) carries its own from construction, and is never cleared. MUST stay
		// the same set as slotName's own cases, or a rebind silently goes unnamed.
		if (node.type === 'var' || node.type === 'mutation' || node.type === 'unary_post') {
			node.name	= name;
			node.bound	= true;
		}
		if (isDeclaration)
			this.scope.create(name, node);
		else
			this.scope.set(name, node);
		this.threadMutation(node);
	}

	// ---- loops and branches ----

	// Shared by every language's own loop lowering: same mu/theta machinery, differing only in whether
	// the test is read before the body (while) or after it (do_while -- the body always runs once
	// first), and in how the body's statement slot is spelled (one statement vs a statement list).
	buildLoop(recurse: Recurse<E, S>, test: E, walkBody: () => void, isDoWhile: boolean, forUpdate?: E) {
		const preLoop	= this.getState();
		const muEnd		= this.makeNode({ type: 'mu' });
		const muScope	= new ScopeMu(this.scope, name => this.makeNode({type: 'muValue', name}), muEnd, () => this.currentFunctionEntry);
		this.scope		= muScope;
		this.connectEnd(muEnd);

		this.loopUpdateStack.push(forUpdate);
		let testNode: Node<E, S, T>;
		if (isDoWhile) {
			muEnd.loopKind = 'do';
			this.exited		= false;
			this.brokeOut	= false;
			walkBody();
			recurse.expression(test);
			testNode	= this.getExprNode(test);
		} else {
			recurse.expression(test);
			testNode	= this.getExprNode(test);
			this.exited		= false;
			this.brokeOut	= false;
			walkBody();
		}
		this.loopUpdateStack.pop();

		connectValue(this.end, 0, muEnd, 1); // Slot 1 = Feedback loop

		const stateTheta = this.makeNode({ type: 'theta' });
		connectValue(muEnd, 0, stateTheta, 0);		// Slot 0 = State predecessor (the loop)
		connectValue(testNode, 0, stateTheta, 1);	// Slot 1 = Loop termination condition
		this.end = stateTheta;

		this.scope = preLoop.scope;
		for (const [name, muNode] of muScope.muNodes) {
			connectValue(muScope.bindings.get(name)!, 0, muNode, 1);		// Slot 1 = Feedback loop

			const theta = this.makeNode({type: 'thetaValue', name});
			connectValue(testNode, 0, theta, 0);	// Slot 0 = Condition
			connectValue(muNode, 0, theta, 1);		// Slot 1 = Value to pass out
			connectValue(stateTheta, 0, theta, 2);	// Scheduling-only anchor, see ScopeMu's own
			this.scope.set(name, theta);
		}
		// The loop AS A WHOLE always falls through to whatever follows it (from the enclosing context's perspective) regardless of whether break/continue happened inside its body.
		this.exited = false;
		this.brokeOut = false;
	}

	/**
	 * `switch` -- the if-cascade every language lowers it into: one binary branch per case ("some case has
	 * already been entered, or this one matches" vs "not yet"), chained forward, with `break_scope` and
	 * its own `switchCases` reconstructing a real `switch` at print time (see `emitControlNode`), and
	 * `switchInternal` keeping that bookkeeping out of the printed output. `cases` are already grouped by
	 * the caller (C++'s own body is a flat list of labels and statements -- see its `switchCasesOf`), and
	 * each body is a WALK, so a language can wrap it in whatever scope it needs.
	 */
	protected buildSwitch(recurse: Recurse<E, S>, discriminant: E, cases: { test?: E, body: () => void }[], syntax: SwitchSyntax<E, S, T>) {
		// The discriminant is evaluated exactly ONCE, into a wrapper every case test reads -- which is
		// also what keeps a side-effecting discriminant from running once per case.
		recurse.expression(discriminant);
		// A helper's name carries the id its own local is about to get (`makeNode` spells ids tag+counter),
		// borrowed without consuming one -- the number that keeps two switches in one ENCLOSING scope apart.
		const discNode	= syntax.local(discriminant, `__disc_${this.nextId}`);
		this.bindVar(discNode);

		// Each case's test is evaluated exactly once too, in source order (a side-effecting test must run
		// once each, in order), captured into its own named flag. `syntax.local` finds the comparison's
		// node through `getExprNode`, so it has to be walked first.
		const caseNodes = cases.map((c, i) => {
			if (!c.test)
				return { matchName: undefined, testNodeId: undefined };
			const comparison	= syntax.comparison(discNode.name, c.test);
			recurse.expression(comparison);
			const matchNode		= syntax.local(comparison, `__match${i}_${this.nextId}`);
			this.bindVar(matchNode);
			return { matchName: matchNode.name, testNodeId: this.getExprNode(c.test).id };
		});
		const matchNames = caseNodes.map(t => t.matchName);

		// A hidden "have we entered a case yet" flag, reassigned like an ordinary variable -- so
		// fallthrough across case boundaries falls out of the same merge machinery any local uses.
		const falseValue	= this.dialect.literal(false);
		recurse.expression(falseValue);
		const hitNode		= syntax.local(falseValue, `__hit_${this.nextId}`);
		this.bindVar(hitNode);

		// The anchor is created AFTER walking the cases (like a gamma's own predecessor/tail split):
		// creating it first would make the first case's own parent.end BE the anchor, so emitChain's
		// backward walk would stop there immediately. The start marker keeps the first case's own
		// state-gamma (if it needs one) off break_scope's own predecessor.
		const predecessor	= this.end;
		const startMarker	= this.makeMarker('BREAK_SCOPE_START');
		this.connectEnd(startMarker);
		this.exited		= false;
		this.brokeOut	= false;

		const switchCases: { testNodeId?: NodeId, boundaryId: NodeId, tailId: NodeId }[] = [];
		for (const [i, c] of cases.entries()) {
			const testExpr	= syntax.condition(hitNode.name, matchNames[i], matchNames.filter((n): n is string => n !== undefined));
			recurse.expression(testExpr);
			const testNode	= this.getExprNode(testExpr);
			const parent	= this.getState();
			let bodyBoundary: Node<E, S, T> | undefined;
			const trueState = this.walkBranch(parent, () => {
				// switchInternal keeps the hit reassignment resolving by name regardless of
				// forcedPrint/needsTemp, since its own mutation is structurally never printed.
				recurse.expression(syntax.setHit(hitNode.name));
				this.scope.get(hitNode.name)!.switchInternal = true;
				bodyBoundary = this.end;
				// The case's own body gets a scope of its own, exactly as a braced block would: a
				// declaration inside one case is local to it, so it can never reach the branch MERGE --
				// where a name only this branch binds would leave reconcileVariables reading a binding
				// the other branch hasn't got.
				this.scope = new Scope(this.scope);
				c.body();
				this.scope = this.scope.closeAndFlush()!;
			});
			const falseState = this.walkBranch(parent, () => {});
			// Any state gamma mergeState builds belongs to switch's own cascade, bypassed completely by
			// switchCases' print-time reconstruction -- tagged switchInternal so isVestigialEdge excludes
			// its condition edge the way it already excludes an ordinary gamma's tail ports.
			const stateGamma = this.mergeState(parent, testNode, trueState, falseState);
			if (stateGamma)
				stateGamma.switchInternal = true;
			this.reconcileVariables(parent, testNode, trueState, falseState);
			switchCases.push({ testNodeId: caseNodes[i].testNodeId, boundaryId: bodyBoundary!.id, tailId: trueState.end.id });
		}

		const breakScope = this.makeNode({ type: 'break_scope', switchDiscriminantId: discNode.id, switchCases });
		connectValue(predecessor, 0, breakScope, 0);
		// Port 1 = the scope's own tail (mirrors a gamma's true/false tail ports): the node emitChain
		// walks backward from to find the wrapped content.
		connectValue(this.end, 0, breakScope, 1);
		this.end		= breakScope;
		this.exited		= false;
		this.brokeOut	= false;
	}

	// Shared by 'if' and 'switch' (each case is structurally its own binary branch, chained forward into the next): resets scope/end/exited to `parent`, walks one branch, captures the result.
	walkBranch(parent: State<E, S, T>, walk: () => void): State<E, S, T> {
		this.setState(new Scope(parent.scope), parent.end);
		walk();
		return this.getState();
	}

	// The STATE-level half of reconciling two branches: does either side need a real structural gamma (a call, or an exit), or does state continue unchanged past a branch that only
	// reassigned variables. Sets `end`/`exited` for whatever comes next.
	mergeState(parent: State<E, S, T>, test: Node<E, S, T>, trueState: State<E, S, T>, falseState: State<E, S, T>): NodeOf<E, S, T, 'gamma'> | undefined {
		if (trueState.exited || falseState.exited || this.hasRealEffect(trueState.end, parent.end) || this.hasRealEffect(falseState.end, parent.end)) {
			const gamma = this.makeNode({ type: 'gamma' });
			connectValue(parent.end, 0, gamma, 0);		// Slot 0 = State predecessor
			connectValue(test, 0, gamma, 1);			// Slot 1 = Condition
			connectValue(trueState.end, 0, gamma, 2);	// Slot 2 = True State
			connectValue(falseState.end, 0, gamma, 3);	// Slot 3 = False State
			this.end = gamma;
			// Only counts as "exited" to whatever encloses it when BOTH sides did -- an implicit
			// empty else always falls through, so the non-existent side already reports exited: false.
			this.exited = trueState.exited && falseState.exited;
			// Same for brokeOut: mixed exit kinds (one breaks, one returns) fall back to false, same
			// as reconcileVariables's "both exited" case -- nothing downstream is reachable either way.
			this.brokeOut = this.exited && trueState.brokeOut && falseState.brokeOut;
			return gamma;
		}
		// No real effect in either branch -- already fully captured by reconcileVariables's own
		// per-variable named gamma. `end` still must reset, or it dangles off whichever branch's
		// mutation-marker chain was walked last instead of the state that actually continues past it.
		this.end		= parent.end;
		this.exited		= trueState.exited && falseState.exited;
		this.brokeOut	= this.exited && trueState.brokeOut && falseState.brokeOut;
		return undefined;
	}

	// True if `name` is currently loop-carried: a `while`'s next iteration sees the update only
	// through the real runtime variable, unlike a one-shot if/switch merge (no graph edge connects
	// one iteration's value to the next's read). The nearest ScopeMu ancestor always owns it.
	isLoopCarried(name: string): boolean {
		for (let s: Scope<E, S, T> | null = this.scope; s; s = s.parent) {
			if (s instanceof ScopeMu && s.muNodes.has(name))
				return true;
		}
		return false;
	}

	// The VALUE half: per-variable reconciliation of everything either branch reassigned.
	reconcileVariables(parent: State<E, S, T>, test: Node<E, S, T>, trueState: State<E, S, T>, falseState: State<E, S, T>) {
		this.scope = parent.scope;
		const divergedVariables = new Set([
			...trueState.scope.bindings.keys(),
			...falseState.scope.bindings.keys()
		]);
		for (const name of divergedVariables) {
			const trueVal	= trueState.scope.get(name)!;
			const falseVal	= falseState.scope.get(name)!;

			// If the values ended up different, create the Gamma stitch
			if (trueVal !== falseVal) {
				// Exactly one branch exited. continue/return/throw: handled entirely by that
				// branch's own forced-printed statement plus JS runtime semantics -- nothing
				// downstream reads this value back through the graph, so merging it here would be
				// wrong (confirmed empirically: corrupts GCM scheduling). break: unlike those, its
				// target (an enclosing loop/switch) DOES read `name` back through the graph, so it
				// falls through to the ordinary gamma-building below.
				if (trueState.exited !== falseState.exited && !(trueState.exited ? trueState : falseState).brokeOut) {
					const exitedVal = trueState.exited ? trueVal : falseVal;
					if (slotName(exitedVal) === name)
						exitedVal.forcedPrint = true;
					this.scope.set(name, trueState.exited ? falseVal : trueVal);
					continue;
				}

				// Each branch's own plain-reassignment node picked up slotName() === name while
				// walked as the tentative final answer -- now superseded by the gamma, so it's
				// cleared, EXCEPT the side that broke out (still needs forcedPrint, which requires
				// slotName() to stay set) and a var_decl's own wrapper (declaring `x` is a
				// separate concern from which value merges where).
				const trueExitedViaBreak	= trueState.exited && !falseState.exited && trueState.brokeOut;
				const falseExitedViaBreak	= falseState.exited && !trueState.exited && falseState.brokeOut;

				// forcedPrint is only NECESSARY when `name` is loop-carried -- a one-shot if/switch
				// merge has no next-iteration read needing a real mutated variable, so a graph edge
				// alone is just as correct. switchInternal is the other reason to force it (switch's
				// own `hit = true;` bookkeeping).
				// gammaValue/exceptValue are excluded from the "supersede, so clear" branch below: their
				// own bound name is a MERGE identity, not a plain reassignment's -- one of them can
				// itself be an operand here (e.g. a later switch case merging against an earlier
				// case's own __hit merge), and it must keep resolving by name for any FURTHER merge
				// chained off it, unlike a plain reassignment genuinely superseded by this one.

				const forcedPrint	= (n: Node<E, S, T>) => slotName(n) === name && (n.switchInternal || this.isLoopCarried(name));
				const clearable		= (n: Node<E, S, T>) => slotName(n) === name && !(n.type === 'var' && n.declKind) && n.type !== 'gammaValue' && n.type !== 'exceptValue';

				if (trueExitedViaBreak && forcedPrint(trueVal))
					trueVal.forcedPrint = true;
				else if (clearable(trueVal))
					trueVal.bound = undefined;

				if (falseExitedViaBreak && forcedPrint(falseVal))
					falseVal.forcedPrint = true;
				else if (clearable(falseVal))
					falseVal.bound = undefined;

				// When one side broke out, its operand still carries slotName() === name -- printing the merge itself under that same name would be circular; neverMaterialize gets the same "never print by this name" outcome directly.
				const gamma = this.makeNode({ type: 'gammaValue', name, neverMaterialize: trueExitedViaBreak || falseExitedViaBreak });
				connectValue(test, 0, gamma, 0); 		// Condition
				connectValue(trueVal, 0, gamma, 1);		// True path
				connectValue(falseVal, 0, gamma, 2);	// False path

				// Commit the Gamma node value directly to the parent scope
				// This ensures downstream code after the branch sees the merged result!
				this.scope.set(name, gamma);
			}
		}
	}

	// ---- functions ----

	// A method/get/set/static_block's own independent function-scoped subgraph, reusing the same
	// entry/return machinery a top-level function declaration gets. entryNode is connected into the
	// outer state chain not because the body runs at this point (it doesn't, except a static block)
	// but so applyGlobalCodeMotion's own region-boundary logic nests it under the right enclosing region.
	buildFunctionBody(recurse: Recurse<E, S>, slots: ParamSlot[] | undefined, body: E | readonly S[]): NodeOf<E, S, T, 'function'> {
		const outer			= this.getState();
		const returnNode	= this.makeMarker('RETURN_ANCHOR');
		const entryNode		= this.makeNode({ type: 'function', returnNodeId: returnNode.id });
		connectValue(outer.end, 0, entryNode, 0);

		// Gives the body its own, unambiguous region root for regionRootOf (applyGlobalCodeMotion)
		// to find -- entryNode's own block isn't safe to use for that.
		const bodyStart		= this.makeMarker('FUNCTION_BODY_START');
		connectValue(entryNode, 0, bodyStart, 0);

		const fnScope		= new Scope<E, S, T>(this.scope);
		fnScope.isFunctionBoundary = true;

		// A hidden param's own temp binding is created below like any other param, but the statements
		// that finish binding it off that temp can't be walked until the function's own state chain is
		// live -- collected here, run right after setState, before the real body statements.
		const pendingParamDesugars: (() => void)[] = [];
		if (slots) {
			// Wire incoming output ports from the entry node directly to parameter bindings.
			// Each param gets its own node (port 0 = State, so params occupy port index + 1);
			let port = 1;
			for (const slot of slots) {
				if ('name' in slot) {
					const paramNode = this.makeNode({type: 'var', name: slot.name});
					connectValue(entryNode, port++, paramNode, 0);
					fnScope.create(slot.name, paramNode);
				} else {
					const tempName = `__destructure${this.nextId++}`;
					const paramNode = this.makeNode({type: 'var', name: tempName});
					connectValue(entryNode, port++, paramNode, 0);
					fnScope.create(tempName, paramNode);
					(entryNode.destructuredParams ??= new Map()).set(slot.token, tempName);
					pendingParamDesugars.push(() => slot.desugar(tempName));
				}
			}
		}

		this.setState(fnScope, bodyStart);

		// A `this`/`super` created anywhere inside gets stamped with the INNERMOST entryNode -- not
		// precisely correct for a nested arrow (real JS shares the enclosing `this`), but still keeps
		// a hoisted this-derived value inside some real function's region instead of the top level.
		const outerFunctionEntry = this.currentFunctionEntry;
		this.currentFunctionEntry = entryNode;
		for (const desugar of pendingParamDesugars)
			desugar();
		if (Array.isArray(body)) {
			for (const stmt of body as readonly S[])
				recurse.statement(stmt);
			// Left unconnected, matching EARLY_RETURN_MARKER's own "bare `return;`" convention --
			// rebuildFunctionBody omits the trailing statement whenever this port is unconnected.
		} else {
			recurse.expression(body as E);
			connectValue(this.getExprNode(body as E), 0, returnNode, 1);
		}
		this.currentFunctionEntry = outerFunctionEntry;

		connectValue(this.end, 0, returnNode, 0);

		// Propagates a captured variable's own reassignment back into the caller's bindings so a
		// later read resolves to it by name -- safe since forcedPrint plus scheduleLate's own
		// region-boundary exclusion keep the reassignment printed inside this function.
		fnScope.closeAndFlush();
		this.setState(outer.scope, outer.end, outer.exited, outer.brokeOut);
		return entryNode;
	}

	/**
	 * Lowers a statement this language does not model as an opaque, verbatim step: `walk` descends
	 * into it (so every binding its text mentions keeps a real reader and nothing gets elided as
	 * dead) while everything that descent creates is stamped `suppressed`, then the statement itself
	 * is anchored into the state chain so it prints in place.
	 *
	 * This is the ONLY correct way to fall back. Merely walking the insides leaves the construct
	 * itself unanchored -- it then vanishes, and its body runs unconditionally: `try { g(); } finally
	 * { h(); }` printed as `g(); h();`, and `for await (const x of y) { g(x); }` as `const x; g(x);`.
	 */
	protected lowerVerbatim(s: S, walk: (s: S) => void): false {
		const outer		= this.getState();
		const wasVerbatim = this.verbatim;
		this.verbatim	= true;
		walk(s);
		this.verbatim	= wasVerbatim;
		// The body's own effects must not become the state chain -- the verbatim statement is a
		// single opaque step, and a predecessor pointing inside it would emit that piece separately.
		this.setState(outer.scope, outer.end, outer.exited, outer.brokeOut);
		this.connectEnd(this.makeNode({type: 'passthru', stmt: s}));
		return false;
	}

	/**
	 * Closes the run off: the state chain's tail becomes the graph's root. The language calls this
	 * once, after its own walker has finished the walk -- see the header's own `BuildVSDG`.
	 */
	finish(): VSDG {
		this.graph.root = this.end.id;
		return this.graph;
	}
}

// ===================================================================
//  BuildProgram -- reconstruction, shared by every language
// ===================================================================

// A real source-level name is only unique WITHIN its own function -- a flat Set can't tell that
// apart from two unrelated functions declaring the same name, printing the second as a bare,
// undeclared reassignment (a guaranteed ReferenceError). A stack of frames (one pushed per function
// body) fixes this while still resolving a genuinely CAPTURED variable: `has` walks the whole stack
// outward, `add` only ever writes to the innermost frame.
export class ScopedNames {
	private stack = [new Set<string>()];
	has(name: string) {
		for (let i = this.stack.length - 1; i >= 0; i--)
			if (this.stack[i].has(name))
				return true;
		return false;
	}
	add(name: string)	{ this.stack[this.stack.length - 1].add(name); }
	push() 				{ this.stack.push(new Set()); }
	pop() 				{ this.stack.pop(); }
}

export type BlockId = string;

type CommonStmt<E> = If<E, unknown> | While<E, unknown> | DoWhile<E, unknown> | Return<E> | ExprStmt<E> | { type: 'break' } | { type: 'continue' };
type CommonExpr<E> = Conditional<E> | Unary<E, unknown>;
function admit<X extends CommonStmt<E>, E, S>(stmt: X): S	{ return stmt as unknown as S; }
function admitExpr<X extends CommonExpr<E>, E>(expr: X): E	{ return expr as unknown as E; }

// `S extends { type: string }` for `isBreakStmt` below: every language's statement union is tagged.
export abstract class Emitter<E, S extends { type: string }, T> {
	protected nodeVariableNames	= new Map<NodeId, string>();
	/** Confirms a name's own statement was ACTUALLY printed somewhere reachable (see ScopedNames). */
	names						= new ScopedNames();
	protected tempVarCounter	= 0;

	// blockIds/blockControl/getLoopDepth are GCM's own output (applyGlobalCodeMotion) -- all
	// undefined for a caller with no GCM pass behind it; only buildProgram/emitChain/needsTemp's own
	// loop-invariant check need them, and each degrades gracefully without a real schedule.
	protected blockNodesCache: Map<BlockId, NodeId[]> | undefined;

	constructor(public readonly graph: VSDG, public readonly dialect: Dialect<E, S, T>, protected blocks?: BlockTree, protected blockIds?: Map<NodeId, BlockId>) {
	}

	// The whole program's statement list, walked backward from programEndId down to PROGRAM_START.
	// 'block_entry' is GCM's own well-known id for PROGRAM_START; without blockControl, it's found
	// the same way BlockTree itself does -- by type and value -- so this works with no GCM at all.
	build(): S[] {
		const programStartId = this.blocks?.getControl('block_entry')
			?? [...this.graph.values()].find(n => n.type === 'marker' && n.name === 'PROGRAM_START')?.id;
		if (!programStartId)
			return [];
		return [...this.emitControlNode(this.graph.getNode(programStartId)), ...this.emitChain(this.graph.root, programStartId)];
	}

	makeTempVar(id: NodeId) {
		const varName = `t${this.tempVarCounter++}`;
		this.nodeVariableNames.set(id, varName);
		return varName;
	}

	// True if `edge` is a gammaValue's own condition port (0) where both branches resolve to the
	// exact same name (buildExpr's own "cond ? x : x" collapse) -- switchInternal, stamped only on
	// switch's own `hit` reassignment, is the reliable signal, since its merge always collapses this
	// way. Counting it as a real consumer would materialize a needless temp.
	isCollapsingGammaValueCondition(edge: Edge): boolean {
		if (edge.port !== 0)
			return false;
		const target = this.graph.get(edge.nodeId)!;
		return target.type === 'gammaValue' && !!(
				(target.inputs[1] && this.graph.get(target.inputs[1].nodeId))?.switchInternal
			||	(target.inputs[2] && this.graph.get(target.inputs[2].nodeId))?.switchInternal
		);
	}

	valueConsumers(node: Node<E, S, T>): Edge[] {
		return (node.outputs[0] ?? []).filter(e => {
			const target = this.graph.get(e.nodeId)!;
			// Port 0 of a control node is its state/predecessor edge, never a value read -- EXCEPT on the
			// per-variable merges, whose port 0 IS the condition they print (`cond ? x : y`). Missing that
			// left an IMPURE condition with a single counted reader, which inlined it -- and the merge's own
			// condition then printed the same call again: `if (g(c)) { } else { } return g(c) ? h(x) : h(y);`.
			if (CONTROL.has(target.type) && e.port === 0 && target.type !== 'gammaValue' && target.type !== 'exceptValue')
				return false;
			// A mu's feedback port (1) is as much a scheduling-only edge as its predecessor port (0)
			// -- never a real value read.
			if ((target.type === 'mu' || target.type === 'muValue') && e.port === 1)
				return false;
			if (target.isVestigialEdge(e.port))
				return false;
			if (this.isCollapsingGammaValueCondition(e))
				return false;
			// A var_decl target that will itself print bare never actually surfaces this value
			// anywhere -- `let x = f();` where x is dead becomes a standalone `f();` instead.
			if (target.type === 'var' && !this.graph.hasRealConsumer(target))
				return false;
			return true;
		});
	}

	// A pure value only needs its own `var tN = ...;` if it's genuinely REUSED (more than one
	// consumer) -- a single consumer can always resolve it lazily and inline it on demand instead,
	// since recomputing a pure expression is valid anywhere its own inputs are.
	// `allowReuse`, when true, exempts only the final "reused, so give it a name" heuristic below --
	// never the structural checks above it, which are about correctness, not readability. Used by
	// isInlinableVarDecl for a literal initializer: duplicating a literal is free, so multiple
	// readers alone shouldn't force a name -- but one feeding a mu's own initial-value port still
	// needs a real, mutable variable for the loop to advance.
	needsTemp(node: Node<E, S, T>, allowReuse = false): boolean {
		// A named theta's own condition edge is real in the graph but never read by codegen -- a
		// while loop's test feeds every loop-carried variable's own theta condition port, so left
		// uncounted a loop with two such variables would see the test as falsely "reused".
		const consumers = (node.outputs[0] ?? []).filter(e => !this.graph.getNode(e.nodeId).isVestigialEdge(e.port) && !this.isCollapsingGammaValueCondition(e));
		// A member-access callee (`obj.method`) must NEVER materialize as a standalone temp --
		// extracting it loses its receiver (`var t0 = update; t0(x);` calls with `this` undefined).
		if (node.type === 'member' && consumers.some(e => this.dialect.isCalleeEdge(this.graph.getNode(e.nodeId), e.port)))
			return false;
		// A mu/muValue's own initial-value/feedback port, or a rebind's own "old value" port, both
		// need the producer addressable by name regardless of reuse count (see mustNameOwnValue).
		if (consumers.some(e => mustNameOwnValue(this.graph.getNode(e.nodeId), e.port)))
			return true;
		// A postfix ++/--'s captured old-value snapshot exists solely to freeze the value before the
		// increment -- inlining it at a later consumer would read the wrong, already-mutated value.
		if (node.type === 'unary_post_old')
			return consumers.length > 0;
		// A consumer that is never emitted itself (a suppressed node inside a statement printed
		// verbatim) cannot recompute this value inline -- `x = 1` followed by a verbatim `assert x >
		// 0` must keep its assignment, or the verbatim text names an undeclared variable.
		if (consumers.some(e => this.graph.getNode(e.nodeId).suppressed))
			return true;
		// A value GCM scheduled SHALLOWER than one of its own real consumers is loop-invariant
		// relative to it (e.g. `a * b` where neither operand is ever reassigned) -- inlining it at
		// the consumer's own position would silently recompute it every iteration, discarding the
		// whole point of hoisting it. No-ops gracefully without a real GCM schedule.
		if (this.blockIds && this.blocks) {
			const ownDepth = this.blocks.getLoopDepth(this.blockIds.get(node.id));
			if (consumers.some(e => this.blocks!.getLoopDepth!(this.blockIds!.get(e.nodeId)) > ownDepth))
				return true;
		}
		return !allowReuse && consumers.length > 1;

		// True when `consumer` reads its producer at `port` in a way that requires it addressable BY
		// NAME regardless of reuse count: a mu/muValue's own initial-value/feedback port (never read
		// via resolveNode, so the producer must be a real statement or `i = i + 1;` vanishes), or a
		// rebind's own "old value" port (inlining it would turn a real mutation into a no-op recompute).
		function mustNameOwnValue(consumer: Node<E, S, T>, port: number): boolean {
			if (consumer.type === 'mu' || consumer.type === 'muValue')
				return true;
			if (port !== 0)
				return false;
			return consumer.type === 'unary_post' || consumer.type === 'mutation';
		}

	}

	// A named slot (a plain reassignment or a gammaValue merge) whose value can be resolved lazily
	// by its sole consumer instead of needing its own printed statement -- same needsTemp criteria
	// as an anonymous temp. Without this, a gammaValue with a single consumer still unconditionally
	// resolves to `Identifier(name)`, correct only when something actually printed `name = ...;` --
	// not guaranteed for a purely-value merge with no state anchor forcing its own block to be visited.
	isInlinableSlot(node: Node<E, S, T>): boolean {
		return !node.forcedPrint
			&& ((node.type === 'mutation' && !!node.plainAssign) || node.type === 'gammaValue')
			&& ((node.type === 'gammaValue' && !!node.neverMaterialize) || !this.needsTemp(node));
	}

	// True if this value reaches code that actually prints: an inlinable slot is printed nowhere, so
	// follow it to ITS consumers instead, all the way down. Anything else -- a statement of its own, a
	// reader that resolves it by name -- surfaces it where it stands. A chain that only ever leads
	// back to itself (an inlinable slot in a loop) surfaces nothing.
	surfacesValue(node: Node<E, S, T>, visiting = new Set<NodeId>()): boolean {
		if (!this.isInlinableSlot(node))
			return true;
		if (visiting.has(node.id))
			return false;
		visiting.add(node.id);
		const surfaces = this.valueConsumers(node).some(e => this.surfacesValue(this.graph.getNode(e.nodeId), visiting));
		visiting.delete(node.id);
		return surfaces;
	}

	// Reconstructs a 'function'-anchored subgraph's own body -- its own fully independent
	// region (own entry/RETURN_ANCHOR pair, own scope). returnNodeId is the only way to find the
	// RETURN_ANCHOR from here -- no ordinary graph edge from entry to return survives an empty body.
	rebuildFunctionBody(entryNode: NodeOf<E, S, T, 'function'>): S[] {
		const returnNode		= this.graph.getNode(entryNode.returnNodeId);
		// A fresh `names` frame per function body -- this function's own locals must never
		// collide with an unrelated sibling/enclosing function's locals sharing the same name.
		this.names.push();
		const bodyStatements	= this.emitChain(returnNode.inputs[0].nodeId, entryNode.id);

		// Unconnected means the body fell off its natural end with no explicit return -- see
		// buildFunctionBody's own comment on why omitting the trailing statement is always correct.
		if (returnNode.inputs[1])
			bodyStatements.push(this.makeReturn(this.resolveOperand(returnNode.id, 1)));
		this.names.pop();
		return bodyStatements;
	}

	// `control`'s own reconstruction, wrapped in the pure nodes GCM co-scheduled with it: its
	// DEPENDENCIES emit first (so a value a branch shares with a co-scheduled slot via CSE is already
	// registered by the time the branch resolves it), then `middle()`, then its DEPENDENTS. `middle`
	// is a thunk so its own emitChain calls run AFTER the dependency half, never before.
	withCoScheduled(nodes: NodeId[], controlId: NodeId, middle: () => S[]): S[] {
		const sortedIds	= this.localTopologicalSort(nodes);
		const i			= sortedIds.indexOf(controlId);
		// Array-literal elements evaluate left to right, so the dependency half runs before `middle()`.
		return [
			...this.emitLocalStatements(sortedIds.slice(0, i)),
			...middle(),
			...this.emitLocalStatements(sortedIds.slice(i + 1)),
		];
	}

	// This control-anchor node's OWN contribution to its enclosing statement list -- the reconstructed
	// if/switch/try/while/function declaration it anchors (plus whatever pure nodes GCM scheduled
	// right alongside it), or (the default case) just those pure nodes, for an anchor with no nested
	// structure of its own (an ordinary call, a declaration, PROGRAM_START, ...).
	emitControlNode(control: Node<E, S, T>): S[] {
		const nodes = this.nodesAt(control.id);

		if (control.type === 'gamma')
			return this.withCoScheduled(nodes, control.id, () => {
				// Ports: 0 = predecessor, 1 = condition, 2 = true tail, 3 = false tail.
				const predecessorId	= control.inputs[0].nodeId;
				const trueStmts		= this.emitChain(control.inputs[2].nodeId, predecessorId);
				// A false tail that never got anywhere past the branch point (no real content) means
				// there's no `else` at all -- as opposed to one that's genuinely empty, which still
				// prints `else {}` (see JS.If's own falseStmts check).
				const falseStmts	= control.inputs[3].nodeId !== predecessorId ? this.emitChain(control.inputs[3].nodeId, predecessorId) : undefined;
				// An `undefined` false tail means no `else` at all; an EMPTY array means a genuinely
				// empty one, which the language still has to spell out.
				// Unless BOTH arms are empty: then the branch's entire content is the value it merges,
				// which prints wherever that value is consumed (a ternary, say) -- the arms are empty
				// because the mutations that make that value are reachable through the value edge, not
				// the state chain. Printing `if (c) {}` beside the ternary repeats the condition and
				// says nothing else. The condition stays load-bearing when it carries an effect (the
				// call is what needed a structural gamma), since then it prints NOWHERE else -- unless it
				// has a temp of its own, which is what runs the call.
				const conditionId = control.inputs[1].nodeId;
				if (trueStmts.length === 0 && !falseStmts?.length
					&& (this.nodeVariableNames.has(conditionId) || this.graph.isPureSubgraph(this.graph.getNode(conditionId))))
					return [];
				return [this.makeIf(this.resolveOperand(control.id, 1), trueStmts, falseStmts)];
			});

		if (control.type === 'break_scope')
			return this.withCoScheduled(nodes, control.id, () => {
				// Reconstructed as a real `switch`/`case` -- break_scope has exactly one creation site
				// (the switch case in a language that has one), which always stamps
				// switchCases first.

				// The discriminant's (and each case test's) own GCM schedule is driven by its graph
				// consumers, not this print-time lookup, so it usually lands somewhere this
				// reconstruction never otherwise visits -- force it here, unless some other surviving
				// value already forced it under the same name.
				const forceDeclare = (id: NodeId): S[] => {
					const n = this.graph.getNode(id);
					return n.type === 'var' && !this.names.has(n.name)
						? this.emitLocalStatements([id]) : [];
				};
				const cases = control.switchCases!.map(c => ({
					test:		c.testNodeId ? this.resolveNode(c.testNodeId) : undefined,
					consequent:	this.emitChain(c.tailId, c.boundaryId),
				}));

				// Once every case's value is elided into the post-switch merge, a case body can end up
				// with nothing but its own trailing `break;` -- if EVERY case is in that shape, the whole
				// dispatch is observably a no-op and drops entirely. A continue/return/throw blocks this.
				const isNoOp = (stmts: S[]) => stmts.length === 0 || (stmts.length === 1 && this.isBreakStmt(stmts[0]));

				return [
					...forceDeclare(control.switchDiscriminantId!),
					...control.switchCases!.flatMap(c => c.testNodeId ? forceDeclare(c.testNodeId) : []),
					...(cases.every(c => isNoOp(c.consequent)) ? [] : [this.makeSwitch(this.resolveNode(control.switchDiscriminantId!), cases)]),
				];
			});

		if (control.type === 'except')
			return this.withCoScheduled(nodes, control.id, () => {
				// Ports: 0 = predecessor, 1 = try's tail, 2 = catch's tail, 3 = finally's tail.
				const predecessorId	= control.inputs[0].nodeId;
				const tryStmts		= this.emitChain(control.inputs[1].nodeId, predecessorId);
				const catchStmts	= this.emitChain(control.inputs[2].nodeId, predecessorId);
				// finally's tail (port 3) is anchored back on `control` itself, not `predecessorId` --
				// its first statement's predecessor is the except node directly (see the 'try' handling),
				// not the state from before the whole try/catch.
				const finallyEdge	= control.inputs[3];
				const finallyStmts	= finallyEdge ? this.emitChain(finallyEdge.nodeId, control.id) : undefined;
				const handlerType	= control.handlerTypeNodeId !== undefined ? this.resolveNode(control.handlerTypeNodeId) : undefined;
				return [this.makeTry(tryStmts, { param: control.catchParam, type: handlerType, body: catchStmts }, finallyStmts)];
			});

		// A DECLARATION (stmt set); a function/arrow/lambda EXPRESSION (expr set) is a value, handled
		// by emitLocalStatements instead.
		if (control.type === 'function' && !control.expr)
			return this.withCoScheduled(nodes, control.id, () => [
				this.rebuildFunctionDecl(control, this.rebuildFunctionBody(control)),
			]);

		if (control.type === 'mu') {
			const thetaEdge	= (control.outputs[0] ?? []).find(e => this.graph.get(e.nodeId)!.type === 'theta');
			const thetaNode	= thetaEdge && this.graph.getNode(thetaEdge.nodeId);

			// The mu's own block holds the mu node plus any loop-body computation whose only real
			// dependency IS the mu (no other anchor to place it at). Anything with a real effect
			// continues from the body's own entry, via port 1 (the feedback input).
			const ownIds		= nodes.filter(id => id !== control.id);

			const statements: S[] = [];

			if (thetaNode) {
				const testId	= thetaNode.inputs[1].nodeId;
				const testNode	= this.graph.getNode(testId);
				// The test's only REAL reader (besides itself) is normally the state-theta's own
				// condition port -- everything else pointing at it is vestigial.
				const onlyReadByLoopExit = (testNode.outputs[0] ?? []).filter(e => !this.graph.getNode(e.nodeId).isVestigialEdge(e.port))
					.every(e => e.nodeId === thetaNode!.id);
				// Emitted before restOfBody, same CSE-registration reasoning as the gamma case above.
				const testStatements	= onlyReadByLoopExit ? [] : this.emitLocalStatements([testId]);
				const restStatements	= this.emitLocalStatements(ownIds.filter(id => id !== testId));
				const restOfBody		= this.emitChain(control.inputs[1].nodeId, control.id);

				if (control.loopKind === 'do') {
					// No rotation needed: the body already runs before the test in do-while's own
					// native semantics (the mu's INITIAL value is what the body sees on its first pass).
					statements.push(this.makeDoWhile([
						...restOfBody,
						...restStatements,
						...testStatements
					], this.resolveOperand(thetaNode.id, 1)));
				} else {
					// LOOP ROTATION: the condition needs values that only exist once already inside the
					// loop body, so `while (cond) {...}` is structurally impossible -- `while (true) {
					// <compute cond>; if (!cond) break; body }` is. A condition resolving to the
					// literal `true` (a real `for(;;)`, or a for-in desugar) makes the check provably
					// dead, so it's dropped instead of printed as inert clutter.
					const condExpr = this.resolveOperand(thetaNode.id, 1);
					statements.push(this.makeWhile(this.dialect.literal(true), [
						...testStatements,
						...(this.dialect.isTrueLiteral(condExpr) ? [] : [this.makeIf(this.makeNot(condExpr), [this.makeBreak()])]),
						...restStatements,
						...restOfBody
					]));
				}
			} else {
				// No exit condition could be found at all (shouldn't normally happen -- every loop
				// creates a state-theta) -- fall back to reconstructing without rotation. Own content
				// emitted before restOfBody, same reasoning as the thetaNode branch above.
				const restStatements = this.emitLocalStatements(ownIds);
				const restOfBody = this.emitChain(control.inputs[1].nodeId, control.id);
				statements.push(this.makeWhile(this.dialect.literal(true), [...restStatements, ...restOfBody]));
			}

			if (thetaNode) {
				// Anything scheduled into the state-theta's own block needs emitting explicitly here,
				// right after the loop -- a pure computation depending only on a named theta's exported
				// value has nothing to state-chain through, so the recursive walk would never find it.
				statements.push(...this.emitLocalStatements(this.nodesAt(thetaNode.id).filter(id => id !== thetaNode!.id)));
			}

			return statements;
		}

		return this.emitLocalStatements(nodes);
	}

	// Reconstructs the statement span (fromId, boundaryId] in original execution order, by walking
	// inputs[0] backward (exactly one real state predecessor per control-anchor node) and appending
	// this node's own contribution AFTER recursing, so output comes out forward. A backward walk from
	// a known endpoint has no ambiguity, unlike a forward walk (several simultaneous forward
	// consumers of the same state token -- each branch's entry AND the eventual merge -- would tie).
	emitChain(fromId: NodeId | undefined, boundaryId: NodeId): S[] {
		if (fromId === undefined || fromId === boundaryId)
			return [];
		const node = this.graph.getNode(fromId);
		// A state-theta's own predecessor IS its loop's mu -- theta has no printable statement of its
		// own; the whole loop is reconstructed once, by the mu, when recursion reaches it via this skip.
		if (node.type === 'theta')
			return this.emitChain(node.inputs[0]?.nodeId, boundaryId);
		return [...this.emitChain(node.inputs[0]?.nodeId, boundaryId), ...this.emitControlNode(node)];
	}

	// A local declaration's initializer needs no printed value when nothing genuinely needs it under
	// x's own name: either it's truly dead, or its one real reader can just recompute the pure
	// initializer inline. Only safe when pure -- an effectful initializer with a real reader must
	// still run at its declared position. capturedRead overrides this: "safe to recompute inline"
	// only holds within a single execution, which a cross-function read isn't.
	isInlinableVarDecl(node: Node<E, S, T>): boolean {
		// declKind, not just node.type === 'var': a PARAM is ALSO a bare 'var' node (inputs[0] wired
		// to the function's entry node, structural plumbing, not a real initializer to recompute) --
		// already handled elsewhere via resolveNode's own no-declKind "read by name" case.
		if (node.type !== 'var' || !node.inputs[0] || node.capturedRead || node.declKind === undefined)
			return false;
		// needsTemp's "reused more than once" heuristic avoids recomputing an expensive expression --
		// not needed for a bare literal, which costs nothing to duplicate. allowReuse (only for a
		// literal initializer) exempts just that heuristic; needsTemp's structural checks (a mu's
		// initial-value port needing a real mutable variable, chief among them) stay in force.
		return !this.needsTemp(node, isLiteral(this.dialect, this.graph.getNode(node.inputs[0].nodeId)));
	}

	// True if some node OTHER than `excludeId` shares `name` as its own binding and is
	// forcedPrint -- will print its own `name = ...;` regardless of what THIS node's consumer count
	// says, so dropping the original declaration would leave that later assignment referencing an
	// undeclared name. A graph-wide scan (small in practice) is the only way to know, since
	// forcedPrint is finalized during BuildVSDG, well before this print-time reasoning runs.
	hasForcedSibling(name: string, excludeId: NodeId): boolean {
		for (const other of this.graph.values()) {
			if (other.id !== excludeId && slotName(other) === name && other.forcedPrint)
				return true;
		}
		return false;
	}

	resolveOperand(to: NodeId, slot: number): E {
		const edge = this.graph.getNode(to).inputs[slot];
		if (!edge)
			throw new Error(`Missing operand edge for slot ${slot} on node ${to}`);
		return this.resolveNode(edge.nodeId);
	}

	// A mutation TARGET (a member/index address) must always reconstruct fresh from the graph rather
	// than go through resolveNode's "already materialized, trust the name" path: the object/property
	// this addresses can hold a DIFFERENT value once the mutation runs, so a cached temp would name
	// the wrong thing. Only a node the language stamped `freshTarget` has this hazard; every other
	// shape (identifier var, muValue, literal) resolves by name/value already, so it keeps resolveNode.
	resolveTarget(to: NodeId, slot: number): E {
		const edge = this.graph.getNode(to).inputs[slot];
		if (!edge)
			throw new Error(`Missing operand edge for slot ${slot} on node ${to}`);
		const opNode = this.graph.getNode(edge.nodeId);
		return opNode.freshTarget ? this.buildExpr(opNode) : this.resolveNode(opNode.id);
	}

	resolveNode(id: NodeId): E {
		const node = this.graph.getNode(id);

		// switch's own internal bookkeeping must always resolve by name, regardless of forcedPrint/
		// needsTemp -- its own mutation is structurally never printed, so folding its value into a
		// ternary elsewhere would wrongly model a "did this already happen" merge for a flag meant to
		// stay independent at every read site.
		const switchInternalName = node.switchInternal ? slotName(node) : undefined;
		if (switchInternalName !== undefined)
			return this.dialect.identifier(switchInternalName);

		// A name rebound inside a statement printed VERBATIM is only defined by that statement's own
		// text (see RawNode's `suppressed`) -- folding its value in here would read a value the graph
		// never printed, so it resolves by name instead. `x = 1; with f(): x = 2; print(x)` has to
		// keep both the declaration and the bare `print(x)`.
		const suppressedName = node.suppressed ? slotName(node) : undefined;
		if (suppressedName !== undefined)
			return this.dialect.identifier(suppressedName);

		switch (node.type) {
			// A local declaration left bare (see isInlinableVarDecl) never actually assigned its name --
			// its sole reader inlines the pure initializer directly. Skipped when a forced sibling
			// exists: some other node already resolves via Identifier(name), and inlining here too
			// would break a merge combining them (losing buildExpr's "cond ? x : x -> x" collapse).
			case 'var':
				if (this.isInlinableVarDecl(node) && !this.hasForcedSibling(node.name, node.id))
					return this.resolveOperand(id, 0);
				// A param (no declKind) is always safe to trust by name. A genuine local declaration
				// falls back to rebuilding the initializer inline if `names` doesn't confirm it
				// was actually printed -- safe since a bare 'var' read always means THIS declaration's
				// own initializer, never a value a later reassignment produced.
				if (!node.declKind || this.names.has(node.name))
					return this.dialect.identifier(node.name);
				return this.resolveOperand(id, 0);

			// A muValue always corresponds to a real, mutable loop-carried variable, forced to
			// materialize regardless of blocks -- always safe to trust by name.
			case 'muValue':
				return this.dialect.identifier(node.name);

			// A thetaValue's exported value IS its mu source's value unchanged -- it exists only to
			// mark where a loop-carried variable becomes readable again after the loop.
			case 'thetaValue':
				return this.resolveOperand(id, 1);
		}

		// `names` confirms `name`'s statement was ACTUALLY printed somewhere reachable -- without
		// a block to schedule it, it may never have been visited at all; falls through to rebuild
		// inline instead of trusting an undeclared identifier.
		const name = slotName(node);
		if (name !== undefined && !this.isInlinableSlot(node) && this.names.has(name))
			return this.dialect.identifier(name);

		const varName = this.nodeVariableNames.get(id);
		if (varName)
			return this.dialect.identifier(varName);

		// Not materialized as a statement anywhere reachable -- most commonly a pure value whose own
		// block was never visited, because a no-real-effect if/else has no structural wrapper to
		// reach it through. Safe to build inline for a pure value; the payload rebuild has no case for
		// an effect ('effect'-typed nodes go through emitLocalStatements instead), so this can't
		// accidentally duplicate a call's execution.
		return this.buildExpr(node);
	}

	// A simple local dependency sorter for a single block's nodes
	localTopologicalSort(ids: NodeId[]): NodeId[] {
		const sorted: NodeId[] = [];
		const visited = new Set<NodeId>();
		const nodeSet = new Set(ids);
		// Tracks nodes OUTSIDE nodeSet already searched through -- never pushed to `sorted`, just
		// walked past, but still need their own cycle guard.
		const walkedThrough = new Set<NodeId>();

		// mu/theta/literal (and a bare 'var' read) resolve directly, never by combining their own
		// inputs -- a mu's port-1 feedback edge in particular points at whatever the loop body
		// computes from the mu itself, so following it here would be both unnecessary and cyclic.
		const hasOrderedInputs = (node: Node<E, S, T>) =>
			node.type !== 'mu' && node.type !== 'muValue' && node.type !== 'theta' && node.type !== 'thetaValue' && !isLiteral(this.dialect, node)
			&& (node.type !== 'var' || node.declKind !== undefined);

		// Before emitting `node`, everything it depends on must be emitted first -- including
		// TRANSITIVELY, through an input that's itself inlined (not its own nodeSet member): e.g.
		// `let e = i + len;` where `i + len` has no own statement is still a real ordering
		// constraint on `e`, or `i`/`e`'s relative order is undefined.
		const visitDeps = (node: Node<E, S, T>) => {
			if (!hasOrderedInputs(node))
				return;
			for (const edge of node.inputs) {
				if (!edge)
					continue;
				if (nodeSet.has(edge.nodeId)) {
					visit(edge.nodeId);
				} else if (!walkedThrough.has(edge.nodeId)) {
					walkedThrough.add(edge.nodeId);
					visitDeps(this.graph.getNode(edge.nodeId));
				}
			}
		};

		const visit = (id: NodeId) => {
			if (visited.has(id))
				return;
			// Marked visited BEFORE recursing (not after): a mu's feedback edge is a genuine back-edge
			// (that's what makes it a loop) -- marking early means a cycle that reaches back here just
			// gets skipped by the `visited.has` check above, instead of recursing forever.
			visited.add(id);
			visitDeps(this.graph.getNode(id));
			sorted.push(id);
		};

		for (const id of ids)
			visit(id);

		return sorted;
	}

	emitLocalStatements(ids: NodeId[]): S[] {
		const statements: S[] = [];

		for (const id of this.localTopologicalSort(ids)) {
			const node = this.graph.getNode(id);

			// Something a verbatim statement already says in full -- emitting it here would run that
			// statement's insides a second time, outside the construct they belong to.
			if (node.suppressed)
				continue;

			if (node.type === 'marker') {
				// Most markers have no source-level statement -- but a user-written break/continue/
				// throw/return does (real control flow routes break/continue to the nearest enclosing
				// loop/switch; return's port 1 is unconnected for a bare `return;`, so an early return
				// nested in a branch prints correctly in place).
				if (node.name === 'BREAK_MARKER')
					statements.push(this.makeBreak());
				else if (node.name === 'CONTINUE_MARKER')
					statements.push(this.makeContinue());
				else if (node.name === 'THROW_MARKER')
					statements.push(this.makeThrow(this.resolveOperand(id, 1)));
				else if (node.name === 'EARLY_RETURN_MARKER')
					statements.push(this.makeReturn(node.inputs[1] ? this.resolveOperand(id, 1) : undefined));
				continue;
			}

			// An effectful call, or a function/arrow/lambda EXPRESSION (both a value and a sequence point).
			if (node.type === 'effect' || (node.type === 'function' && node.expr)) {
				// buildExpr, not rebuildPayload: a function-expression's payload IS this language's own
				// expr (already handled above it), so no language has to spell that case out again.
				const value = this.buildExpr(node);
				// Safe to inline (skip its own `var tN = ...;`) with EXACTLY ONE real value consumer:
				// it's rootBlocks-anchored to a fixed position, so a pure node consuming it has its
				// scheduling window capped there, and the payload rebuild reconstructs operands in
				// state-chain order -- inlining through a pure single-consumer chain preserves order
				// regardless. valueConsumers, not needsTemp: sharing needsTemp's counter here changed
				// other callers.
				// A consumer that is ITSELF printed nowhere (an inlinable slot) can only surface this value
				// through consumers of its own, so it doesn't count as one that will -- and that has to be
				// followed all the way down: `int r = 0; r = g(x); return 0;` deferred the call to a store
				// that dropped, and `if (c) r = g(x); else r = h(y);` to a merge of two dropped stores.
				// With no live consumer left, nothing resolves this node at all, so printing it as a bare
				// statement (rather than naming a temp nothing reads) recomputes nothing.
				const live = this.valueConsumers(node).filter(e => this.surfacesValue(this.graph.getNode(e.nodeId)));
				if (live.length === 1)
					continue; // deferred -- the sole consumer inlines it via resolveNode's fallback
				// A dialect-declared "only rewrites that binding" effect with no live consumer either is a
				// dead store: `i++;` whose `i` is never read again is the same dead write `i = 1;` would be.
				// "Live" matters on both sides -- a reader that is itself never printed (`if (c) a = i++;`
				// merging a dead `i`) cannot observe the write, and the effect's text still prints wherever
				// its VALUE is used, which is where the write actually happens. The readers are scanned raw
				// rather than through valueConsumers: a loop-carried read arrives on a mu's feedback port,
				// which that treats as scheduling-only, and `for (...; i++)` must not be dropped for it.
				// Anything unmodelled that canNOT claim this (a member target, a call) still prints.
				const mutated	= node.type === 'effect' && node.mutatesBindingId !== undefined
					? this.graph.getNode(node.mutatesBindingId) : undefined;
				const observed	= !!mutated && (mutated.outputs[0] ?? [])
					.some(e => !this.graph.getNode(e.nodeId).isVestigialEdge(e.port)
						&& this.surfacesValue(this.graph.getNode(e.nodeId)));
				if (live.length === 0 && mutated && !observed)
					continue;
				statements.push(live.length
					? this.makeTempDecl(this.makeTempVar(id), value)
					: this.makeExpressionStmt(value)
				);
				continue;
			}

			const name = slotName(node);
			if (name !== undefined) {
				// A plain reassignment or named merge is only worth printing under x's own name if
				// genuinely reused -- a single real consumer can always resolve it lazily instead.
				// forcedPrint overrides this: a reassignment on an exited branch must always print.
				if (this.isInlinableSlot(node))
					continue;
				// A named except never gets a statement of its own -- each branch already prints its
				// own `x = ...;` directly (forcedPrint); this node exists only so GCM schedules
				// downstream readers of `x` correctly.
				if (node.type === 'exceptValue')
					continue;
				const namedStmt = this.emitNamedSlot(name, node);
				if (namedStmt)
					statements.push(namedStmt);
				continue;
			}

			// A pure literal is read directly by resolveNode, never its own statement -- same as the
			// var/mu/... group below (a 'floating' literal has no dedicated tag to list there).
			if (isLiteral(this.dialect, node))
				continue;

			switch (node.type) {
				case 'var':
				case 'mu':
				case 'muValue':
				case 'theta':
				case 'thetaValue':
					// No statement of their own -- read directly by resolveNode. (markers and effect/
					// function-expression values are already handled above.)
					break;

				case 'passthru':
					// A genuinely codeless declaration (interface/type-alias/enum/... or a construct
					// this language chose not to model) -- node.stmt prints verbatim, always regardless
					// of reference count, unlike an ordinary value.
					statements.push(this.emitPassthru(node));
					break;

				case 'class_decl':
					// The language's own rebuildClass splices VSDG's resolution of heritage/keys/
					// method-bodies back into the otherwise-verbatim class before printing.
					statements.push(this.rebuildClassDecl(node));
					break;

				case 'function':
					// A declaration is intercepted earlier by emitControlNode; a function/arrow
					// EXPRESSION value is handled above. Reaching here means neither fired -- no-op
					// rather than mis-printing.
					break;

				default:
					// forcedPrint: an unnamed node with a real side effect but no value consumer at all
					// -- needsTemp alone would see zero consumers and drop it, correct only for a pure
					// value, never for an effect nothing reads back. A mutation rebuilds as its own
					// STATEMENT (a language without assignment-expressions has no value form at all),
					// not via the expression payload's merged-value reading (`y = (x = 1)` returns only
					// the right-hand side there, which is wrong here).
					if (node.forcedPrint) {
						statements.push(node.type === 'mutation'
							? this.rebuildMutationStatement(node)
							: this.makeExpressionStmt(this.buildExpr(node)));
					} else if (this.needsTemp(node)) {
						statements.push(this.makeTempDecl(this.makeTempVar(id), this.buildExpr(node)));
					}
					// else: single-use, same-block -- left unmaterialized; its sole consumer inlines it
					// directly via resolveNode's fallback when it resolves this operand.
			}
		}

		return statements;
	}

	// True for a node reached via the state chain's port-2 "triggering rebind" convention whose
	// statement must print under its own name regardless of block placement: a rebind or a genuine
	// local declaration -- unlike a gammaValue/named-except merge (a pure value with no state anchor).
	needsDirectPlacement(node: Node<E, S, T>): boolean {
		switch (node.type) {
			case 'unary_post':	return true;
			// A TYPE is a declaration too: C++ has no declaration KEYWORD, so its var nodes carry no
			// declKind (setting one would also tell `isInlinableVarDecl` it may elide the value, which
			// would make an assignment's own TARGET resolve to the initializer -- `0 = 1`).
			case 'var':			return node.declKind !== undefined || node.typeAnnotation !== undefined;
			case 'mutation':	return !(node.plainAssign && this.isInlinableSlot(node));
			default:			return false;
		}
	}

	// The inverse of blockIds: which nodes GCM scheduled into a given block, grouped once on first
	// use. A node with no entry in blockIds is left out of every block's list rather than defaulted
	// into 'block_entry' (which used to dump the whole graph there whenever blockIds was incomplete)
	// -- it falls through to resolveNode's own inline fallback wherever it's actually read instead.
	blockNodes(blockId: BlockId): NodeId[] {
		if (!this.blockNodesCache) {
			this.blockNodesCache = new Map();
			for (const id of this.graph.keys()) {
				const bId = this.blockIds?.get(id);
				if (bId === undefined)
					continue;
				if (!this.blockNodesCache.has(bId))
					this.blockNodesCache.set(bId, []);
				this.blockNodesCache.get(bId)!.push(id);
			}
		}
		return this.blockNodesCache.get(blockId) ?? [];
	}
	// Which nodes GCM scheduled alongside a given control-anchor node. Without an assigned block,
	// still returns [anchorId] itself, not [] -- GCM's own convention (an anchor is a member of its
	// own block) is what lets emitControlNode's default case print an ordinary effect/call this way.
	// Also checks for a rebind whose own port-2 state-anchor trigger is this anchor: needsTemp forces
	// such a node to materialize regardless of reuse count, so it needs a real, correctly-positioned
	// statement even when GCM never scheduled it anywhere on its own.
	nodesAt(anchorId: NodeId): NodeId[] {
		const bId = this.blockIds?.get(anchorId);
		if (bId !== undefined)
			return this.blockNodes(bId);
		const ids = [anchorId];
		for (const edges of this.graph.getNode(anchorId).outputs) {
			if (!edges)
				continue;
			for (const e of edges) {
				if (e.port === 2 && this.needsDirectPlacement(this.graph.getNode(e.nodeId)))
					ids.push(e.nodeId);
			}
		}
		return ids;
	}

	// Shared by a 'floating''s own 'conditional' case and the outer 'gammaValue' case -- a gammaValue
	// is a per-variable value merge, reconstructed as a ternary (exactly what it means); the state
	// gamma itself never reaches here at all (reconstructed separately, by emitControlNode's own
	// 'gamma' case, as a real if/else).
	buildConditional(node: Node<E, S, T>): E {
		const consequent	= this.resolveOperand(node.id, 1);
		const alternate		= this.resolveOperand(node.id, 2);
		// Both operands can genuinely resolve to the SAME bare name (e.g. a broken-out merge, see
		// reconcileVariables's own neverMaterialize case) -- `cond ? x : x` always just equals `x`.
		// Only while the condition is PURE, though: this ternary is the condition's one printed place
		// (`if (g()) a = i++; else a = i++;` merges `a` into the old `i`, and dropping the ternary
		// there dropped the call with it).
		const cName = this.dialect.identifierName(consequent);
		if (cName !== undefined && cName === this.dialect.identifierName(alternate)
			&& this.graph.isPureSubgraph(this.graph.getNode(node.inputs[0].nodeId)))
			return consequent;
		return this.makeConditional(this.resolveOperand(node.id, 0), consequent, alternate);
	}

	buildExpr(node: Node<E, S, T>): E {
		switch (node.type) {
			case 'gammaValue':
				return this.buildConditional(node);

			// An inlinable effectful call/function expression left unmaterialized -- its sole consumer
			// resolves it directly. A function/arrow/lambda EXPRESSION prints verbatim (GCM never
			// moves bodies). A 'mutation' node reaching here as a VALUE means it was superseded by an
			// if/else merge (e.g. `y = (x = 1)`) rather than printed as its own statement -- what's
			// needed is just the value produced.
			case 'floating':
			case 'mutation':
			case 'effect':
			case 'member':
			case 'unary_post':
			case 'unary_post_old':
				return this.rebuildPayload(node);
			case 'function':
				if (node.expr)
					return node.expr;
				break;
		}
		console.log(`not handling value node ${node.type}`);
		return this.dialect.literal(null);
	}

	// ---- this language's reconstruction half ----

	/** Rebuilds a node's own expression payload: a pure value, a mutation read as a VALUE, an effect, a member select, a ++/--. */
	abstract rebuildPayload(node: Node<E, S, T>): E;
	/** Rebuilds a mutation as its own STATEMENT (Python's assignment isn't an expression at all). */
	abstract rebuildMutationStatement(node: Node<E, S, T>): S;
	/** A name's own printed statement: its declaration, its first assignment, or a reassignment. */
	abstract emitNamedSlot(name: string, node: Node<E, S, T>): S | undefined;
	abstract emitPassthru(node: NodeOf<E, S, T, 'passthru'>): S;
	abstract rebuildClassDecl(node: NodeOf<E, S, T, 'class_decl'>): S;
	abstract rebuildFunctionDecl(node: NodeOf<E, S, T, 'function'>, body: S[]): S;

	/**
	 * The structural statements a reconstruction needs. Bodies are STATEMENT ARRAYS, not a wrapped
	 * block node: js/c put one statement (a `Block` when the source braced it) in those slots while
	 * py needs a list, so the language -- the only side that knows -- does the wrapping. An
	 * `undefined` alternate is "no else at all"; an EMPTY body array is a genuinely empty one, which
	 * still has to be spelled (`else {}` / `else:` with a `pass`).
	 */
	abstract makeBlock(body: S[] | undefined): S|S[]|undefined;
	abstract makeSwitch(discriminant: E, cases: { test?: E, consequent: S[] }[]): S;
	/**
	 * A try/handler/finally. The handler is an object rather than positional parameters because a
	 * handler is genuinely three things -- a bound name, the type it MATCHES (a language whose
	 * `except` clause can be typed; js's `catch` cannot), and its body.
	 */
	abstract makeTry(body: S[], handler: { param?: string, type?: E, body: S[] }, finalizer?: S[]): S;
	abstract makeThrow(argument: E): S;
	abstract makeTempDecl(name: string, value: E): S;

	// Everything below is a shape all three ASTs SHARE -- common.ts's own constructors, which is what
	// lets the core build them at all (see the file header). A language overrides one only where its
	// own representation genuinely differs, so `makeBlock` is the only per-language part of a plain
	// if/while/do-while.
	//
	// HANDING ONE BACK AS `S`/`E` TAKES ONE ASSERTION, and it cannot be designed away: a union is a
	// supertype of its members, so a `Common.If` really IS a statement of each of these languages -- but
	// the compiler knows only a type parameter's CONSTRAINT, so from where it stands `S` is some subtype
	// of the common shapes and `Common.If` may be something it doesn't have. No constraint can say "S is
	// a union that contains these": a constraint is a lower bound, never an upper one. So the fact is
	// stated once, in `admit`/`admitExpr` -- whose own input types are exactly what may be admitted --
	// and each construction below stays an ordinary constructor call.


	makeIf(test: E, cons: S[], alt?: S[]): S		{ return admit(If(test, this.makeBlock(cons), this.makeBlock(alt))); }
	makeWhile(test: E, body: S[]): S				{ return admit(While(test, this.makeBlock(body))); }
	makeDoWhile(body: S[], test: E): S				{ return admit(DoWhile(this.makeBlock(body), test)); }
	makeReturn(argument?: E): S 					{ return admit(Return(argument)); }
	makeBreak(): S									{ return admit({ type: 'break' }); }
	makeContinue(): S								{ return admit({ type: 'continue' }); }
	makeExpressionStmt(value: E): S					{ return admit(ExprStmt(value)); }
	makeConditional(test: E, cons: E, alt: E): E	{ return admitExpr(Conditional(test, cons, alt)); }
	makeNot(value: E): E							{ return admitExpr(Unary('!', value)); }
	isBreakStmt(stmt: S): boolean					{ return stmt.type === 'break'; }
}

const CONTROL = new Set<string>(['effect', 'marker', 'gamma', 'gammaValue', 'mu', 'muValue', 'theta', 'thetaValue', 'break_scope', 'except', 'exceptValue', 'function', 'passthru', 'class_decl']);

// ===================================================================
//  Optimisation
// ===================================================================

export function optimize<E, S, T>(graph: VSDG, dialect: Dialect<E, S, T>): void {
	const protectedIds = collectProtectedNodeIds(graph);
	for (let changed = true; changed; ) {
		changed = false;

		for (const node of graph.values()) {
			// 1. Try to fold constant math operations
			if (foldConstants(graph, dialect, node))
				changed = true;

			// 2. Try to eliminate dead if/else branches
			if (foldDeadBranches(graph, dialect, node, protectedIds))
				changed = true;
		}

		// 3. Merge structurally-identical pure computations -- runs once per round (a whole-graph
		// pass, unlike the two per-node checks above): constant folding can turn two expressions
		// identical, and CSE merging can turn a condition constant, so neither converges alone.
		if (optimizeStructuralCSE(graph, dialect, protectedIds))
			changed = true;
	}
}

function foldConstants<E, S, T>(graph: VSDG, dialect: Dialect<E, S, T>, node: Node<E, S, T>): boolean {
	// A 'mutation' is deliberately excluded (not just practically inert -- a real assignment's left
	// operand is never itself a literal) -- folding a mutation into a bare literal would silently
	// discard the effect it exists to perform. The dialect's own `foldable` decides the rest.
	const arity = dialect.foldable(node);
	if (!arity)
		return false;

	const operands: unknown[] = [];
	for (let i = 0; i < arity; i++) {
		const edge = node.inputs[i];
		const producer = edge && graph.get(edge.nodeId);
		if (!producer || !isLiteral(dialect, producer))
			return false;
		operands.push(dialect.literalValue(producer.expr));
	}

	const r = dialect.foldValue(node, operands);
	if (r === undefined)
		return false;

	// Fold in place into this language's own literal form -- the SAME 'floating' tag, so no consumer
	// has to be rewired -- then drop the now-meaningless incoming edges. There is no second copy of the
	// value to keep in sync: `dialect.literalValue` reads the folded payload straight back out.
	// `foldable` owns the "does this node's payload fold at all" question, so reaching here means
	// this node is one of the expr-carrying tags; the cast is that contract, not a guess.
	(node as Node<E, S, T> & { expr: E }).expr	= dialect.literal(r);
	graph.removeInputs(node);
	return true;
}

// Every NodeId referenced OUTSIDE the ordinary inputs/outputs edge graph (switchCases, returnNodeId,
// classInfo, ...). None of foldConstants/foldDeadBranches/optimizeStructuralCSE know about these
// side channels -- they only rewire inputs/outputs -- so a node reachable ONLY this way must never
// be removed/merged away, or the reference is left pointing at a deleted id.
export function collectProtectedNodeIds<E, S, T>(graph: VSDG): Set<NodeId> {
	// `[graph.root]`, not `graph.root`: a NodeId is a string, and `new Set('gamma7')` is the set of
	// its CHARACTERS -- which left the root itself unprotected.
	const ids = new Set<NodeId>([graph.root]);
	for (const node of graph.values()) {
		if (node.type === 'function')
			ids.add(node.returnNodeId);
		if (node.type === 'except' && node.handlerTypeNodeId !== undefined)
			ids.add(node.handlerTypeNodeId);
		if (node.type === 'break_scope') {
			if (node.switchDiscriminantId !== undefined)
				ids.add(node.switchDiscriminantId);
			for (const c of node.switchCases ?? []) {
				if (c.testNodeId !== undefined)
					ids.add(c.testNodeId);
				ids.add(c.boundaryId);
				ids.add(c.tailId);
			}
		}
		if (node.classInfo) {
			if (node.classInfo.superClassNodeId !== undefined)
				ids.add(node.classInfo.superClassNodeId);
			for (const m of node.classInfo.members) {
				if (m.keyNodeId !== undefined)
					ids.add(m.keyNodeId);
				if (m.entryNodeId !== undefined)
					ids.add(m.entryNodeId);
				if (m.valueNodeId !== undefined)
					ids.add(m.valueNodeId);
			}
		}
	}
	return ids;
}

function foldDeadBranches<E, S, T>(graph: VSDG, dialect: Dialect<E, S, T>, node: Node<E, S, T>, protectedIds: Set<NodeId>): boolean {
	// We are looking for Gamma nodes (gammaValue or the state gamma)
	if (node.type !== 'gamma' && node.type !== 'gammaValue')
		return false;
	// Never remove a node some out-of-band NodeId field still points at -- see
	// collectProtectedNodeIds's own comment. A gamma/gammaValue isn't a typical side-channel
	// target, but this stays a real guard rather than an assumption. The ROOT is the exception:
	// it is a reference too, but one that can be MOVED rather than refused (see below), so a
	// constant-conditioned if/else at the very end of a program still collapses.
	const wasRoot = node.id === graph.root;
	if (!wasRoot && protectedIds.has(node.id))
		return false;

	// A gammaValue has [condition, true, false] at ports 0/1/2; the state gamma has an extra
	// state-predecessor at port 0, shifting those three to ports 1/2/3.
	const port = node.type === 'gammaValue' ? 0 : 1;

	// Find the edge supplying the condition
	const condEdge = node.inputs[port];
	if (!condEdge)
		return false;

	const condNode = graph.getNode(condEdge.nodeId);

	// If the condition is a known constant (or truthy/falsy value)
	if (isLiteral(dialect, condNode)) {
		// Find the edge representing the winning path (true path, then false path)
		const winningEdge = node.inputs[dialect.truthy(dialect.literalValue(condNode.expr)) ? port + 1 : port + 2];
		if (!winningEdge)
			return false;

		// Bypass this Gamma node entirely: reconnect every downstream consumer to read directly from
		// the winning branch source. node.outputs[port] entries are CONSUMER-shaped, the opposite
		// shape from winningEdge (PRODUCER-shaped) -- the consumer's own inputs[] is what changes.
		const winningNode = graph.getNode(winningEdge.nodeId);
		for (const subscribers of node.outputs) {
			for (const consumerEdge of subscribers) {
				graph.getNode(consumerEdge.nodeId).inputs[consumerEdge.port] = { nodeId: winningEdge.nodeId, port: winningEdge.port };
				(winningNode.outputs[winningEdge.port] ??= []).push({ nodeId: consumerEdge.nodeId, port: consumerEdge.port });
			}
		}
// Everything that read the merge now reads the surviving branch's tail, which is therefore
		// the end of the state chain.
		if (wasRoot)
			graph.root = winningEdge.nodeId;
		
		// Delete the Gamma node and its incoming edges from the graph
		graph.removeNode(node);
		return true; // Graph was modified!
	}

	return false;
}

function getStructuralKey<E, S, T>(graph: VSDG, dialect: Dialect<E, S, T>, node: Node<E, S, T>): string {
	let key = node.type;
	// Checked as three separate fields now (expr/name/stmt), not one untyped `value` -- 'member'
	// (its own `.name` + `.optional`) never actually reaches here, since optimizeStructuralCSE's
	// own caller excludes it before ever calling this. Whether a 'floating' node's own real
	// discriminator lives in node.expr's own .type rather than node.type, and how to spell it, is
	// the dialect's business (exprKey).
	const payload = node as Node<E, S, T> & { expr?: E, name?: string, stmt?: S };
	if (payload.expr) {
		key += dialect.exprKey(payload.expr);
	} else if (payload.name !== undefined) {
		key += payload.name;
	} else if (payload.stmt) {
		key += dialect.stmtKey(payload.stmt);
	}

	return key + ':' + node.inputs.map(e => e ? `${e.nodeId}:${e.port}` : '').join(',');
}

export function optimizeStructuralCSE<E, S, T>(graph: VSDG, dialect: Dialect<E, S, T>, protectedIds: Set<NodeId>): boolean {
	let anyChanges = false;

	// Maps a structural string signature back to the first Node that computed it
	const structuralTable = new Map<string, Node<E, S, T>>();

	for (const node of graph.values()) {
		// Skip nodes with side-effects or control-flow tokens -- sequence-dependent, can't collapse
		// on data inputs alone. 'mutation' is unsafe for the most direct reason: each occurrence is a
		// distinct real effect. Anything else whose VALUE differs between two identical-looking
		// occurrences (a fresh array/object identity, a per-call receiver, an lvalue read a mutation
		// can change in between) is the dialect's own call -- see isCSEUnsafe.
		if (['mu', 'muValue', 'theta', 'thetaValue', 'gamma', 'gammaValue', 'effect', 'marker', 'function', 'member', 'mutation'].includes(node.type))
			continue;
		if (dialect.isCSEUnsafe(node))
			continue;

		// Generate the unique structural signature for this node
		const key = getStructuralKey(graph, dialect, node);

		// Check if an identical calculation has already been recorded
		const masterNode = structuralTable.get(key);

		// A protected node must never be the one removed -- merging it away leaves that field
		// dangling. Left unregistered in structuralTable too, so it never becomes a future
		// duplicate's "master" either.
		if (masterNode && masterNode.id !== node.id && protectedIds.has(node.id))
			continue;

		if (masterNode && masterNode.id !== node.id) {
			// Found a duplicate! We must merge 'node' into 'masterNode'.

			// 1. Redirect every downstream consumer reading from 'node'
			node.outputs.forEach((subscribers, outputPort) => {
				for (const consumerEdge of subscribers) {
					const consumerNode = graph.getNode(consumerEdge.nodeId);

					// Update the consumer's input slot to point directly to the master node
					consumerNode.inputs[consumerEdge.port] = {
						nodeId: masterNode.id,
						port: outputPort
					};

					// Register the consumer into the master node's dynamic broadcast channel
					(masterNode.outputs[outputPort] ??= []).push({
						nodeId: consumerNode.id,
						port: consumerEdge.port
					});
				}
			});

			// 2. Disconnect 'node' from its original up-stream producers
			// 3. Remove the duplicate node completely from the master VSDG compilation context
			graph.removeNode(node);
			anyChanges = true;
		} else {
			// This is the first time we've seen this exact expression; register it as the master
			structuralTable.set(key, node);
		}
	}

	return anyChanges;
}

// ===================================================================
//  GCM
// ===================================================================

//generic graph helpers
function findLeastCommonAncestor<N>(tree: Map<N, N>, a: N, b: N): N|null {
	const pathA = new Set<N>();

	// Trace path from Block A all the way up to the entry root
	for (let i: N|undefined = a; i; i = tree.get(i))
		pathA.add(i);

	// Trace path from Block B up until it hits any block visited by Path A
	for (let i: N|undefined = b; i; i = tree.get(i)) {
		if (pathA.has(i))
			return i; // Found the intersection point!
	}
	return null;
}

function isDeeperThan<N>(tree: Map<N, N>, a: N, b: N): boolean {
	let depthA = 0;
	for (let i: N|undefined = a; i; i = tree.get(i))
		depthA++;

	let depthB = 0;
	for (let i: N|undefined = b; i; i = tree.get(i))
		depthB++;

	return depthA > depthB;
}

// Discovers the program's branch/loop structure -- purely from control anchors and each one's own state predecessor, with no involvement from ordinary value nodes.
// It doesn't decide where anything reused/floating gets placed (applyGlobalCodeMotion's own job, layered on top), just answers "where are the branches and loops, and how do they nest."

export class BlockTree {
	roots	= new Map<NodeId, BlockId>();
	control = new Map<BlockId, NodeId>();	// The reverse of rootBlocks
	tree	= new Map<BlockId, BlockId>();	// Maps a Block ID to its immediate parent Block ID in the Dominator Tree
	loopDepthMemo = new Map<BlockId, number>();

	constructor(public graph: VSDG) {
		// PROGRAM_START gets the well-known id 'block_entry' -- BuildProgram needs a fixed, known starting point to begin its traversal from.
		let blockCounter = 0;
		for (const [id, node] of graph.entries()) {
			switch (node.type) {
				case 'marker':
					if (node.name === 'PROGRAM_START') {
						this.roots.set(id, 'block_entry');
						break;
					}
					//fallthrough
				case 'effect':
				case 'function': case 'passthru': case 'class_decl':
				case 'gamma': case 'mu': case 'theta': case 'break_scope':
				case 'except':
					this.roots.set(id, `${node.type}_${blockCounter++}`);
					break;
			}
		}

		for (const [nodeId, blockId] of this.roots) {
			this.control.set(blockId, nodeId);
			const incomingStateEdge = graph.get(nodeId)?.inputs[0];
			if (incomingStateEdge)
				// Find which block contains the node that produced our incoming state token
				this.tree.set(blockId, this.roots.get(incomingStateEdge.nodeId) ?? '');
		}
	}
	// How many loops enclose a block: a state-mu's own block is one deeper than its blockTree
	// parent; a state-theta's block is the EXIT of its own mu -- despite being a blockTree
	// descendant of it, it runs once after the loop, so its depth is the loop's OWN parent's,
	// not one more; every other block just inherits its parent's depth unchanged.
	getLoopDepth(id?: BlockId): number {
		if (id === undefined)
			return 0;
		const cached = this.loopDepthMemo.get(id);
		if (cached !== undefined)
			return cached;
		
		this.loopDepthMemo.set(id, 0); // defensive cycle guard; block_entry has no parent, so real cycles shouldn't occur
		const parentDepth	= this.getLoopDepth(this.getParent(id));
		const node			= this.control.has(id) ? this.graph.get(this.control.get(id)!) : undefined;

		let depth = parentDepth;
		if (node?.type === 'mu') {
			depth = parentDepth + 1;
		} else if (node?.type === 'theta') {
			const muBlockId		= this.roots.get(node.inputs[0].nodeId); // the state-theta's own mu
			depth = this.getLoopDepth(muBlockId && this.getParent(muBlockId));
		}
		this.loopDepthMemo.set(id, depth);
		return depth;
	}
	getRoot(id: BlockId) 								{ return this.roots.get(id); }
	getControl(id: BlockId) 							{ return this.control.get(id); }
	getParent(id: BlockId) 								{ return this.tree.get(id); }
	isDeeperThan(idA: BlockId, idB: BlockId) 			{ return isDeeperThan(this.tree, idA, idB); }
	findLeastCommonAncestor(idA: BlockId, idB: BlockId) { return findLeastCommonAncestor(this.tree, idA, idB); }

}

export function applyGlobalCodeMotion<E, S, T>(graph: VSDG) {
	const blockIds = new Map<NodeId, BlockId>();
	const blocks = new BlockTree(graph);

	// Which function's own region a block belongs to -- walks blockTree up until hitting either
	// 'block_entry' or a function's own FUNCTION_BODY_START marker. Deliberately NOT the
	// 'function' entry's own block: that's reachable from BOTH the function's body and whatever
	// textually follows the declaration, so blockTree ancestry alone can't tell them apart -- the
	// dedicated start marker is what disambiguates, since only the body threads from it.
	const regionRootMemo = new Map<BlockId, BlockId>();
	function regionRootOf(blockId: BlockId): BlockId {
		const cached = regionRootMemo.get(blockId);
		if (cached !== undefined)
			return cached;
		const control = blockId !== 'block_entry' ? graph.get(blocks.getControl(blockId)!) : undefined;
		let root = blockId;
		if (blockId !== 'block_entry' && !(control?.type === 'marker' && control.name === 'FUNCTION_BODY_START')) {
			const parent = blocks.getParent(blockId);
			root = parent !== undefined ? regionRootOf(parent) : blockId;
		}
		regionRootMemo.set(blockId, root);
		return root;
	}

	// A 'function' entry's own block is deliberately ambiguous for regionRootOf -- but a PARAM reading
	// that node directly (ports >= 1, port 0 reserved for the state chain) is never one of the two
	// ambiguous cases: it's unconditionally inside the function. scheduleEarly uses this instead of
	// the entry's own block for such edges, or a value derived only from params gets pinned
	// at a block regionRootOf resolves to block_entry, stranding it outside the function.
	const functionBodyBlockMemo = new Map<NodeId, BlockId>();
	function functionBodyBlockOf(functionDeclId: NodeId): BlockId {
		const cached = functionBodyBlockMemo.get(functionDeclId);
		if (cached !== undefined)
			return cached;
		const bodyStart = (graph.get(functionDeclId)!.outputs[0] ?? [])
			.map(e => graph.get(e.nodeId)!)
			.find(n => n.type === 'marker' && n.name === 'FUNCTION_BODY_START');
		const block = (bodyStart && blocks.getRoot(bodyStart.id)) ?? blocks.getRoot(functionDeclId)!;
		functionBodyBlockMemo.set(functionDeclId, block);
		return block;
	}

	// Phase 1: Push everything as early as possible
	const visitedEarly = new Set<NodeId>();

	function scheduleEarly(nodeId: NodeId) {
		if (visitedEarly.has(nodeId))
			return;
		visitedEarly.add(nodeId);


		// Fixed anchoring nodes (control-flow or side effects) are pinned to their own blocks
		const root = blocks.getRoot(nodeId);
		if (root) {
			blockIds.set(nodeId, root);
			return;
		}

		const node = graph.get(nodeId)!;// as NodeWithBlock;

		// Default to the program's first entry block -- unless this is a `this`/`super` node (or
		// anything stamped with scopeAnchorId), which has no input edges to floor it against its
		// own function otherwise.
		let earliestBlock = node.scopeAnchorId !== undefined ? functionBodyBlockOf(node.scopeAnchorId) : "block_entry";

		// Recursively process all input dependencies first
		node.inputs.forEach((edge, port) => {
			if (!edge)
				return;
			// A mu's port 1 is its FEEDBACK edge -- a genuine back-edge. Recursing into it here would
			// chase that cycle; the mu's own earliest position never needs it anyway, only its
			// initial value (port 0) and any scheduling-anchor edge.
			if ((node.type === 'mu' || node.type === 'muValue') && port === 1)
				return;
			// A muValue's port 2 ties it to its owning mu's block unconditionally -- correct for a
			// genuinely loop-carried variable, but wrong for one whose port-1 feedback is just a
			// trivial self-loop (proving it's loop-invariant) -- skipping this floor for that case is
			// exactly what makes loop-invariant hoisting fall out of scheduleEarly for free.
			if (node.type === 'muValue' && port === 2 && node.inputs[1]?.nodeId === nodeId)
				return;
			scheduleEarly(edge.nodeId);
			// The current node must be scheduled AFTER its inputs are ready -- find the deepest block
			// among all inputs. A param edge (port >= 1) uses the function's own body block, not the
			// entry's own -- and 'function' covers both a declaration and an arrow/function expression.
			const edgeBlock	= graph.get(edge.nodeId)!.type === 'function' && edge.port !== 0
				? functionBodyBlockOf(edge.nodeId)
				: blockIds.get(edge.nodeId);
			if (edgeBlock !== undefined && blocks.isDeeperThan(edgeBlock, earliestBlock))
				earliestBlock = edgeBlock;
		});

		blockIds.set(nodeId, earliestBlock);
	}

	for (const nodeId of graph.keys())
		scheduleEarly(nodeId);

	// Phase 2: Pull things down to save execution costs
	const visitedLate = new Set<NodeId>();

	function scheduleLate(nodeId: NodeId) {
		if (visitedLate.has(nodeId))
			return;
		visitedLate.add(nodeId);


		// Pin fixed execution nodes
		if (blocks.getRoot(nodeId))
			return;

		const node = graph.get(nodeId)!;

		// Recursively process all downstream consumers first
		for (const portChannels of node.outputs) {
			if (portChannels)
				for (const consumerEdge of portChannels)
					scheduleLate(consumerEdge.nodeId);
		}

		const isSchedulingIrrelevant = (consumerNode: Node<E, S, T>, port: number): boolean => {
			switch (consumerNode.type) {
				case 'mu':
				case 'muValue':		return port === 1;
				case 'gammaValue':	return port !== 0;
				case 'exceptValue': return true;
				case 'theta':		return port === 1;
				// A postfix's snapshot edge: vestigial for values (see isVestigialEdge) but exactly what
				// keeps the snapshot from sinking past the increment, so it must count here.
				case 'unary_post':	return false;
				default:			return consumerNode.isVestigialEdge(port);
			}
		};

		// Find the Least Common Ancestor (LCA) block of all consumers
		let latestBlock: BlockId | null = null;

		for (const portChannels of node.outputs) {
			if (portChannels) {
				for (const consumerEdge of portChannels) {
					const consumerNode = graph.get(consumerEdge.nodeId)!;
					if (isSchedulingIrrelevant(consumerNode, consumerEdge.port))
						continue;

					let consumerBlock = blockIds.get(consumerEdge.nodeId)!;

					// A mu's port 0 (its INITIAL, pre-loop value) belongs to the block BEFORE the loop --
					// the pre-header, the immediate dominator sitting right outside the loop structure.
					if ((consumerNode.type === 'mu' || consumerNode.type === 'muValue') && consumerEdge.port === 0)
						consumerBlock = blocks.getParent(consumerBlock) || "block_entry";

					// A consumer in a DIFFERENT function's own region (e.g. a captured variable's
					// reassignment, read by name after the function returns) might run zero, one, or many
					// times, at a point this static schedule can't place -- treating it as an ordinary
					// constraint would (and did) drag the node out of the function it belongs in.
					// forcedPrint keeps such a node from being dropped once its only consumer is excluded.
					if (regionRootOf(consumerBlock) !== regionRootOf(blockIds.get(nodeId)!))
						continue;

					latestBlock = latestBlock === null
						? consumerBlock
						: blocks.findLeastCommonAncestor(latestBlock, consumerBlock);
				}
			}
		}

		// Click's Core Sinking Choice: walk from the latest possible block up to the earliest, picking the SHALLOWEST valid block along the way (lowest execution frequency)
		// -- never shallower than earliestBlock's own depth, which already encodes the deepest position this node's inputs actually require.
		//
		// Ties matter: getLoopDepth only counts LOOP nesting, so blocks within one loop iteration (or one un-looped chain) can tie despite being meaningfully different positions.
		// On a tie, prefer whichever is closer to latestBlock, not earliestBlock -- otherwise a node whose sole consumer lives right next to it gets hoisted back to its earliest
		// position, landing in a different block than the consumer that needs it.
		//
		// KNOWN GAP, deliberately not fixed here (tried and reverted):
		// two adjacent, same-depth declarations that are each other's own anchor (`let i = off, e = i + len;`) can have this tie-break pick the wrong one, swapping their printed order.
		// A version preferring a node's own port-2 anchor on a tie fixed that but broke dead-bookkeeping elision elsewhere (a switch's own unused `__hit`/`__match` scaffolding)
		// -- the two cases are indistinguishable from information available at this point in scheduling.
		const earliestBlock	= blockIds.get(nodeId)!;
		const floor			= blocks.getLoopDepth(earliestBlock);
		let bestDepth		= Infinity, bestBlock;

		// The `currentBlock` guard is a defensive backstop against a blockTree dead end that doesn't pass through earliestBlock on the way to the root.
		let currentBlock: BlockId | undefined = latestBlock || earliestBlock;
		while (currentBlock !== undefined) {
			const depth = blocks.getLoopDepth(currentBlock);
			if (depth >= floor && depth < bestDepth) {
				bestDepth = depth;
				bestBlock = currentBlock;
			}
			// earliestBlock (depth === floor) is always a valid candidate and is included in this
			// walk, guaranteeing bestBlock ends up set -- so stop right after considering it.
			currentBlock = currentBlock === earliestBlock ? undefined : blocks.getParent(currentBlock);
		}

		blockIds.set(nodeId, bestBlock!);
	}
	for (const nodeId of graph.keys())
		scheduleLate(nodeId);

	return { blocks, blockIds };
}
