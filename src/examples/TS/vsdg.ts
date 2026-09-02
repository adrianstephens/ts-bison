/* eslint-disable @typescript-eslint/no-this-alias */
import * as JS from './js-parser';
import * as TS from './ts-parser';
import { Identifier, Literal } from '../common';
import { Walkable, walkB, calcUnary, calcBinary, RecurseB, isJsStatement, isTsDeclaration } from './walker';

const ASSIGN_OPS	= new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);
type Expr			= TS.Expr;
type Statement		= TS.Statement;

// VSDG

type NodeId = string;

interface Edge {
	nodeId:	NodeId;
	port:	number; 
}
interface ClassMember {
	keyNodeId?: NodeId;
	entryNodeId?: NodeId;
	valueNodeId?: NodeId;
}
interface ClassInfo {
	superClassNodeId?: NodeId;
	members: ClassMember[];
};

class Node {
	inputs:		Edge[]		= [];	// inputs[port] = The single specific source edge feeding this slot
	outputs:	Edge[][]	= [];	// outputs[port] = An array of ALL downstream edges consuming this specific channel
	// Set when this node's result is the current binding of a real source-level variable (a var_decl,
	// a plain reassignment, or a ++/-- target) -- tells Output to print it under that name (declaring
	// it once via `declKind`, then a plain reassignment) instead of an anonymous `const tN = ...` temp.
	boundName?:	string;
	declKind?:	JS.DeclarationKind;
	// The declarator's own source type annotation (`let x: Foo = ...`), stamped once at var_decl
	// construction and threaded back through at every reconstruction of `x`'s own declaration.
	// Without it, an explicitly-typed empty-collection literal (`const result: ExportEntry[] = [];`)
	// silently reconstructs as an untyped one (`const result = [];`), changing what TS infers for
	// `result` -- found on real code (binary-libs/src/pe.ts): downstream `.sort((a: ExportEntry,
	// b: ExportEntry) => ...)` became a real type error once the annotation was gone.
	typeAnnotation?: TS.Type;
	// A reassignment whose branch exited (break/continue/return): its merge into "whatever
	// continues after the if" was skipped entirely (see the 'if' handler's exit-collapse), since
	// that merge point is unreachable from an exited path -- so it has no value-consumer for
	// needsTemp to count. Its OBSERVABLE mutation still has to happen, in place, before the
	// exit -- e.g. `i = i + 1; continue;` needs the real `i = i + 1;` printed, not silently
	// dropped as if it were a dead, uninlined pure value. Forces emitLocalStatements to print it
	// regardless of consumer count.
	forcedPrint?: boolean;
	// A named gamma whose consequent/alternate operand still carries boundName === this gamma's own
	// name (see reconcileVariables's "broke out" case): printing it as `name = op0 ? name : name;`
	// would be circular, since both operands would resolve as `Identifier(name)` too, referring to
	// whatever's there at that LATER point (the merge's own about-to-be-computed result), not the
	// distinct values actually being merged. Forces isInlinableSlot to treat it as inlinable
	// regardless of consumer count -- always resolved lazily (inlined, or an anonymous temp) instead
	// of ever printing as its own `name = ...;` statement, which is fine here: the real, observable
	// assignment already happened via the broken-out side's own forcedPrint. Deliberately NOT the
	// same as leaving it unnamed: back before gammaValue had its own type tag (distinct from the
	// state gamma), an unnamed one was indistinguishable, to buildBlockTree's own anchor-discovery,
	// from a real STATE-merging gamma (both shared `typeof value !== 'string'`), which mis-scheduled
	// it as a parentless root block (found and fixed the hard way, and part of why they're two
	// distinct tags now) -- neverMaterialize gets the same outcome without relying on that at all.
	neverMaterialize?: boolean;
	// Tags a STATE mu as belonging to a `do...while` loop rather than an ordinary `while`. Can't
	// reuse `.value` for this the way a named muValue/theta/gammaValue would -- `.value` being a
	// string is still what distinguishes a NAMED (per-variable) theta from the unnamed state one
	// (mu/gamma each get their own type tag instead, muValue/gammaValue, so `.value` is free there
	// for other purposes -- but this field stays separate regardless, since it's meaningless for
	// anything but a do-while's own state mu). Read only by Output's own 'mu' handling
	// (emitControlNode), to pick which shape to reconstruct: `do { body } while (test);` needs no
	// loop-rotation trick at all (the body already runs before the test, unlike `while`, so there's
	// nothing to rotate).
	loopKind?: 'do';
	// The catch clause's own binding name (e.g. 'e'), stamped on the STATE `except` anchor for
	// Output's own 'except' handling (emitControlNode) to reconstruct `catch (e) {...}` with. Can't
	// reuse `.value` here either, for the exact same reason as `loopKind` above -- it's what
	// distinguishes a NAMED (per-variable) except from the unnamed state one.
	catchParam?: string;
	// A function_decl/class_decl's own RETURN_ANCHOR node id, stamped on the entry node so
	// Output's own reconstructFunctionBody can find it -- there's no ordinary graph edge from
	// entry to return (the only edge is FINAL STATE -> return, discovered by walking the body's own
	// chain backward, which for an EMPTY body coincides with entry itself and so can't be told apart
	// from "there is no return node" by edge-walking alone).
	returnNodeId?: NodeId;
	// Stamped on a function_decl/entry node for each of its own params that's a destructuring
	// pattern (see buildFunctionBody's own addParam): maps the ORIGINAL pattern object (the exact
	// same object still sitting in node.value's own .params, since that AST is otherwise printed
	// verbatim) to the hidden temp name its own value was actually bound to. Without this, the
	// printed signature keeps showing the original pattern while the body's own flat var_decls
	// (patternBindings) read a name the signature never actually binds -- a real ReferenceError,
	// not cosmetic. Consulted by Output's own function_decl/rebuildClass reconstruction (the only
	// two places a function's signature is spliced back together, not printed fully verbatim) to
	// rebuild the printed param list with each pattern replaced by its own temp name.
	destructuredParams?: Map<JS.BindingTarget, string>;
	// Stamped ONLY on the top-level PROGRAM_START node, right before BuildVSDG returns: the id of
	// the program's own final state-chain node (whatever `end` held at that point). The top-level
	// program has no RETURN_ANCHOR/return value the way a function does, so unlike returnNodeId this
	// points directly at the final state itself -- Output's own top-level entry point uses it as the
	// starting point for the same backward walk reconstructFunctionBody already does for a function.
	programEndId?: NodeId;
	// Stamped on a `break_scope` node that reconstructs a real `switch`, not just an arbitrary
	// break-target: the discriminant to print in `switch(...)`, and each case's own printable test
	// (undefined for `default`) plus the graph span its body actually occupies. `testNodeId` is the
	// VSDG node c.test resolved to when it was walked (as part of building `__matchN = disc ===
	// c.test`, see BuildVSDG's 'switch' case) -- resolving THAT node for printing, rather than
	// printing the raw source `c.test` expression directly, is what makes a non-literal case test
	// (an identifier VSDG renamed, or one with a real effect) print correctly instead of bypassing
	// VSDG's own resolution entirely. `boundaryId` is deliberately NOT the same node `mergeState`'s
	// own predecessor plumbing would use -- it's captured AFTER the case's own `hit = true;` marker,
	// so that marker falls OUTSIDE the span Output's own emitChain walks, hence never printed.
	// `__hit`/`__match` themselves aren't pointless, though: a value reassigned
	// differently across fallthrough-connected cases still needs them as the post-switch merge's own
	// condition (see reconcileVariables) -- they're just no longer used to DRIVE printed control flow,
	// only to correctly compute a merge when one survives, and cleanly disappear from output otherwise.
	switchDiscriminantId?: NodeId;
	switchCases?: { testNodeId?: NodeId; boundaryId: NodeId; tailId: NodeId }[];
	// Stamped on switch's own internal bookkeeping nodes (`__hit`'s reassignment, each case's own
	// `__matchN` boolean) -- these are NOT real user data, but reach reconcileVariables/resolveNode
	// through the exact same generic path an ordinary reassignment does (see BuildVSDG's 'switch'
	// case), since they're synthesized as fake source and walked via the normal expression hook.
	// Without this tag, resolveNode has no way to tell "this must always resolve by name, its own
	// mutation is structurally never printed" (true for __hit/__matchN -- switchCases's own
	// boundaryId is captured AFTER the `hit = true;` marker specifically so it falls outside the
	// printed span) apart from an ordinary reassignment like `total = 10;`, whose own inlining
	// decision legitimately depends on forcedPrint/needsTemp. Conflating the two is what broke case
	// dispatch when forcedPrint was made conditional (see isLoopCarried's own comment): __hit's
	// value got folded into a real "did an earlier case match" merge, which is correct for the
	// ACTUAL running switch but wrong for the independent, one-shot match flags computed here.
	switchInternal?: boolean;
	// Stamped on a 'this'/'super' node with its enclosing function_decl's own id -- unlike a param,
	// which reaches its owning function via a real graph edge (inputs[0]), 'this'/'super' have NO
	// inputs at all (BuildVSDG's own getExprNode just registers a bare node), so scheduleEarly has
	// nothing to floor their placement against and defaults them to block_entry, the top-level
	// program -- found the hard way, testing against a real multi-method class: a `this`-derived
	// value forced to materialize (a genuinely loop-invariant `this.method` reference, hoisted by
	// scheduleEarly's own loop-invariant logic) printed OUTSIDE the class entirely, referencing
	// `this` where it doesn't exist. scheduleEarly's own param-edge redirect (see its own comment)
	// uses this the same way it uses a param's function_decl edge, via functionBodyBlockOf.
	scopeAnchorId?: NodeId;
	// Stamped on whatever node `export`/`export_decl` left behind (via `end`, right after
	// recursing its own wrapped declaration through the ordinary statement dispatch) -- read back
	// by whichever print site produces that node's own statement, to wrap it in `export `/
	// `export default `. Recursing the wrapped declaration through the SAME dispatch every other
	// statement uses (rather than giving `export`/`export_decl` their own separate verbatim
	// wrapper) is what keeps a `class_decl`/`function_decl` inside an export from being built
	// twice -- once by that recursion, once more by the export wrapper's own now-redundant verbatim
	// reprint (which used to embed the already-recursed declaration a second time).
	exported?: 'named' | 'default';
	// Stamped on a var declaration's own node the first time it's READ from inside a DIFFERENT
	// function than the one it's declared in (see getExprNode's own identifier resolution, and
	// isLocalToCurrentFunction). A single apparent consumer normally makes a pure value safe to
	// inline (isInlinableVarDecl) -- sound only when that consumer runs within the SAME, single
	// execution as the declaration. A captured read doesn't: the reading function may run zero,
	// one, or many times, at a point this pass can't place relative to the declaration, so it must
	// always re-read the variable BY NAME, never substitute whatever value happened to be true at
	// declaration time. Same reasoning as forcedPrint for a captured WRITE (BuildVSDG's 'binary'
	// case) -- this is its read-side counterpart, found the hard way (a runtime check, not just
	// print inspection, was what actually caught this: `n = n + 1;` prints correctly under either
	// bug, but silently computes `0 + 1` every call instead of re-reading `n`).
	capturedRead?: boolean;
	// Stamped on a 'member' node (`obj.prop`) with the source's own `?.` marker -- `case 'member':`
	// keeps only `s.property` (a plain string) as `.value`, unlike 'index' (`obj[expr]`), which
	// keeps the WHOLE original expr object (so its own `.optional` survives for free); this is
	// `member`'s equivalent, tracked as its own field for the same reason. Dropped entirely before
	// this field existed: `this.PE.opt?.DataDirectory` silently reconstructed as
	// `this.PE.opt.DataDirectory`, a real behavior change (throws instead of short-circuiting to
	// undefined when `opt` is nullish) -- found on real code (binary-libs/src/pe.ts).
	optional?: boolean;
	// Stamped on a class's own anchor node (an 'effect' for a class EXPRESSION, a 'passthru' for a
	// class_decl -- see BuildVSDG's buildClass) with whatever of its own pieces got real VSDG
	// resolution: the heritage expression, and each member's own computed key / static field value /
	// method-or-accessor-or-static-block-or-instance-field-initializer body (via its own independent
	// function-scoped subgraph, entryNodeId -- see buildFunctionBody's own comment for why it
	// carries no graph edge of its own). `members` is index-aligned with the ORIGINAL `body` array
	// node.value still holds -- Output's own rebuildClass splices each resolved piece back in,
	// everything else still copied through verbatim.
	classInfo?: ClassInfo;
	constructor(public id: string, public type: string, public value?: any) {}
	inDegree()	{ return this.inputs.length; }
	outDegree() { return this.outputs.reduce((sum, arr) => sum + arr.length, 0); }
	isUnused(port: number) { return this.outputs[port]?.length === 0; }

	// A node's real source-variable name, if it has one -- either a direct rebind (var_decl/reassignment/++--,
	// tagged via `boundName`) or a per-variable gammaValue/named-except merge (which stores the name in
	// `.value` instead, since `.value` is otherwise free for either -- unlike binary/unary nodes, which
	// need it for their operator). except has no separate type tag for its named form (unlike
	// gamma/gammaValue) since it's never mistaken for a rootBlocks anchor by anything besides the
	// `typeof value` check itself -- see buildBlockTree's own rootBlocks discovery.
	slotName(): string | undefined {
		if (this.boundName !== undefined)
			return this.boundName;
		if (this.type === 'gammaValue')
			return this.value;
		if (this.type === 'except' && typeof this.value === 'string')
			return this.value;
		return undefined;
	}

	// True when an edge into `consumer` at `port` exists in the graph but is never actually read by
	// codegen -- so it must not be counted as a real reader when deciding whether something is reused,
	// dead, or safe to inline, nor allowed to constrain GCM's scheduling as if it were an ordinary
	// dependency. Two shapes, both "wired up generically, but not always consulted":
	//  - A plain `x = ...` assignment's "old value"/left-operand edge (port 0): unlike a compound `+=`
	//    (where the old value genuinely feeds the result), buildExpr only ever resolves the right-hand
	//    side for a plain `=`.
	//  - A thetaValue's "condition" edge (port 0): resolveNode always resolves a thetaValue through
	//    its mu source (port 1) instead -- the condition edge exists only so GCM can see the dependency
	//    that makes the export valid no earlier than loop-exit, never because codegen reads it.
	isVestigialEdge(port: number): boolean {
		if (this.type === 'binary' && port === 0
			&& ASSIGN_OPS.has((this.value as Expr & { type: 'binary' }).operator)
			&& (this.value as Expr & { type: 'binary' }).operator === '='
		)
			return true;
		if (this.type === 'thetaValue' && port === 0)
			return true;
		// threadMutation's own marker edge (always port 2, on whatever node rebindVar just bound --
		// a var_decl/rebind, or a reassignment expression): purely a GCM ordering anchor, never read
		// as a value by resolveOperand/buildExpr (a var's real value is always port 0; a reassignment
		// only ever reads its right operand, port 1). Without this, isPureSubgraph's own recursion
		// (which has no other way to tell a scheduling-only edge from a real value dependency) walks
		// straight into the marker -- an 'effect' node -- and wrongly calls the WHOLE subgraph
		// impure, even when nothing in the actual value chain has any real effect at all.
		if ((this.type === 'var' || this.type === 'binary') && port === 2)
			return true;
		// A state gamma's true/false-tail ports (2/3) are structural only: Output's own emitChain
		// walks `control.inputs[2]/[3]` directly (backward from each branch's own tail) to find where
		// each branch's content starts, never through resolveOperand -- so a call that happens to be
		// the last effect in its branch is never actually "read" for its VALUE just by virtue of
		// being that branch's tail.
		if (this.type === 'gamma' && (port === 2 || port === 3))
			return true;
		// A switchInternal gamma's own condition (port 1) too -- unlike an ordinary if's gamma, which
		// genuinely needs to read it to print `if (cond)`, this one belongs to switch's own internal
		// if-cascade, which switchCases's own print-time reconstruction bypasses entirely (see
		// BuildVSDG's own switch case, which tags exactly this gamma switchInternal for this reason).
		if (this.type === 'gamma' && this.switchInternal && port === 1)
			return true;
		// A break_scope's own tail port (1): same reasoning as a gamma's tail ports -- Output's own
		// emitChain walks it directly (backward from the scope's own tail) to find where the scope's
		// wrapped content starts, never through resolveOperand.
		if (this.type === 'break_scope' && port === 1)
			return true;
		// A state-merging (unnamed) except's try/catch/finally tails (1/2/3): same reasoning as a
		// state-gamma's own tail ports -- Output's own emitChain finds each part's content the same
		// way, never through resolveOperand. Unlike gamma, a NAMED except's own value
		// ports (0/1, try/catch) are NOT vestigial here either way -- resolveNode never resolves
		// them directly (there's no printable condition to build a ternary from the way a named
		// gamma's ternary can), so they simply never get visited via that path in the first place.
		return this.type === 'except' && typeof this.value !== 'string' && (port === 1 || port === 2 || port === 3);
	}
}

function connectValue(
	from:	Node, outputPort: number,
	to:		Node, inputPort: number
): void {
	to.inputs[inputPort] = { nodeId: from.id, port: outputPort };
	(from.outputs[outputPort] ??= []).push({ nodeId: to.id, port: inputPort });
}

// INVARIANT for any "scheduling-only" edge (one added purely to influence GCM's placement of `to`,
// not read by codegen -- e.g. ScopeMu's stateAnchor edge, or a mutation marker): applyGlobalCodeMotion's
// scheduleEarly computes a NON-anchored node's position as "at least as deep as the deepest of my
// inputs", with NO exceptions and no awareness of what an edge conceptually means. So `from` must be
// something whose depth is a genuine STRUCTURAL lower bound for `to` -- i.e. `to` is structurally
// required to live at or after `from` (a loop-carried mu can never be valid shallower than its own
// loop; a state anchor is fixed at a known depth) -- never merely INCIDENTAL (e.g. "this call happens
// to be the most recent one, and happens to be inside a branch"). Violating this doesn't just get the
// order wrong: since scheduleEarly treats the edge as an ordinary depth-inducing dependency, `to` gets
// pulled to `from`'s ACTUAL depth, which can drag an unconditional statement inside a conditional
// `from` merely happened to be nested in -- e.g. `if (i) { g(i); } i = i + 1;` silently becoming
// `if (i) { g(i); i = i + 1; }`, an infinite loop whenever `i` is falsy. This was found the hard way:
// see the reverted `threadReassignment` attempt in BuildVSDG's history for the concrete case.


class Scope {
	// Maps variable names to the VSDG NodeId that currently holds its value
	local	= new Set<string>;
	bindings = new Map<string, Node>();
	// Set only on the scope functionScope creates (never on an ordinary block scope -- if/while
	// body, etc). Distinguishes "reassigns a name declared somewhere in the ENCLOSING function"
	// (an ordinary local, ultimately merged/reconciled the normal way) from "reassigns a name
	// CAPTURED from further out" (crosses a function boundary -- see isLocalToCurrentFunction,
	// used by BuildVSDG's 'binary' case to decide whether a reassignment needs forcedPrint).
	isFunctionBoundary = false;

	constructor(public parent: Scope | null = null) { }
	closeAndFlush() {
		if (this.parent) {
			for (const [name, node] of this.bindings.entries()) {
				if (!this.local.has(name))
					this.parent.bindings.set(name, node);
			}
		}
		return this.parent;
	}
	create(name: string, node: Node): void {
		this.local.add(name);
		this.bindings.set(name, node);
	}
	set(name: string, node: Node): void {
		this.bindings.set(name, node);
	}
	get(name: string): Node | undefined {
		return this.bindings.get(name) ?? this.parent?.get(name);
	}

	// True if `name` is declared somewhere between the current scope and the nearest enclosing
	// function boundary (an ordinary local -- an if/while/for body is just another Scope link in
	// this same chain, so this walks straight through those). False means it's CAPTURED from
	// further out -- reassigning it is an effect that escapes the current function, needing
	// forcedPrint the same way a property assignment does (see BuildVSDG's 'binary' case): its
	// value can't be safely inlined based on a same-region consumer count when the actual
	// "consumer" might be arbitrarily far away, in a caller that hasn't run yet. No enclosing
	// function at all (true top-level code) has no boundary to cross, so it's trivially "local".
	isLocalToCurrentFunction(name: string): boolean {
		for (let s: Scope | null = this; s; s = s.parent) {
			if (s.local.has(name))
				return true;
			if (s.isFunctionBoundary)
				return false;
		}
		return true;
	}

}

class ScopeMu extends Scope {
	muNodes = new Map<string, Node>();

	// `stateAnchor` (the loop's real state-mu) is only used for a scheduling-only edge below -- a
	// named per-variable mu isn't itself a rootBlock anchor (its inputs[0] is an initial VALUE, not
	// state), so without some real dependency pulling it deeper than the pre-loop block, GCM would
	// happily schedule anything that depends on it (e.g. the loop body's own reassignment) as if it
	// were loop-invariant and float it out before the loop entirely.
	// `currentFunctionEntry` is a GETTER (not a value) for the same reason scopeAnchorId's own
	// stamping site reads it live rather than capturing it once: a name looked up from a FURTHER
	// nested function inside this loop's own body (its own scope chain reaching back here) needs
	// THAT function's entry, not whichever one was current when this ScopeMu was constructed.
	constructor(parent: Scope, public makeNode: (type: string, varName: string) => Node, public stateAnchor: Node, public currentFunctionEntry: () => Node | undefined) {
		super(parent);
	}
	public get(name: string): Node | undefined {
		const node = this.bindings.get(name);
		if (node)
			return node;
		const old = this.parent?.get(name);
		if (old) {
			const mu = this.makeNode('muValue', name);
			// A name read from OUTSIDE the current function (see capturedRead's own comment,
			// getExprNode's identifier case) that ALSO happens to be read inside a loop -- e.g.
			// `sorted` here, a plain outer const, never reassigned, but still wrapped in a muValue
			// like any other outer-scope read a loop body touches (this constructor doesn't know in
			// advance which names will actually be reassigned) -- needs the SAME floor this/super
			// already get: without it, scheduleEarly's own loop-invariant-hoisting rule (correctly
			// recognizing the trivial self-feedback here, see its own comment) can float a value
			// PURELY DERIVED from this mu (e.g. `sorted.length`) out past the function/arrow it's
			// lexically inside entirely, into the ENCLOSING function -- which never reads it, since
			// an arrow/function EXPRESSION's own body prints verbatim from its original source,
			// completely unaware of anything GCM decided (found on real code, binary-libs/src/pe.ts:
			// `var t14 = sorted.length;` materialized outside a `.map()` callback, read only INSIDE
			// it, in a nested while loop's own test -- computed but never referenced anywhere).
			mu.scopeAnchorId = this.currentFunctionEntry()?.id;
			this.muNodes.set(name, mu);		//original mu
			this.bindings.set(name, mu);	// current node
			connectValue(old, 0, mu, 0);			// Slot 0 = Initial value from outside
			connectValue(this.stateAnchor, 0, mu, 2);	// Slot 2 = scheduling-only: "at least as deep as the loop"
			return mu;
		}
	}
}

class VSDG extends Map<NodeId, Node> {
	constructor() {
		super();
	}

	getNode(id: NodeId): Node {
		const node = this.get(id);
		if (!node)
			throw "missing node";
		return node;
	}

	getEdge0(node: Node, slot: number) {
		return node.inputs[slot];
	}
	getEdge(id: NodeId, slot: number) {
		return this.getNode(id).inputs[slot];
	}

	removeInputs(node: Node) {
		for (const e of node.inputs) {
			const down = this.getNode(e.nodeId);
			down.outputs[e.port] = down.outputs[e.port].filter(e => e.nodeId !== node.id);
		}
		// Clears node's OWN inputs too, not just the producers' outputs -- a caller that folds
		// `node` into a self-contained literal (see foldConstants) but leaves this array stale
		// left a dangling reference nothing else would ever clean up: harmless for printing (a
		// literal's own inputs are never read), but a later pass that walks EVERY node's inputs
		// unconditionally (e.g. applyGlobalCodeMotion's scheduleEarly) would still chase it,
		// crashing once the now-truly-unreferenced producer got removed by a later CSE pass.
		node.inputs = [];
	}
	removeNode(node: Node) {
		this.removeInputs(node);
		this.delete(node.id);
	}

	clearDeadNodes() {
		for (let changed = true; changed; ) {
        	changed = false;
			for (const node of this.values()) {
				if (node.type !== 'effect' && node.outDegree() === 0) {
					this.removeNode(node);
					changed = true;
				}
			}
		}
	}
}

export function BuildVSDG(ast: Walkable): VSDG {
	interface State { scope: Scope, end: Node, exited: boolean, brokeOut: boolean };

	const graph		= new VSDG;
	const expnodes	= new Map<Expr, Node>;
	let scope		= new Scope(null); // The global scope
	let nextId		= 0;
	// The innermost function_decl currently being walked (undefined at the top level) -- set/
	// restored around buildFunctionBody's own recursion, purely so a 'this'/'super' node created
	// anywhere inside can be stamped with its own scopeAnchorId (see Node's own field comment).
	let currentFunctionEntry: Node | undefined;

	// Names never declared anywhere in this file -- globals, built-ins (`console`, `Math`), and
	// anything imported. Real cross-file/ambient resolution is somebody else's job (TStypeCheckAsync),
	// not this pass's -- it just needs to read them by name without crashing, so each gets a single,
	// shared, declKind-less 'var' node (same shape a parameter already has: no boundName, so it never
	// gets a declaration statement of its own -- see getExprNode's fallback below).
	const externalNodes = new Map<string, Node>();

	function makeNode(type: string, value?: any) {
		const id	= type + String(nextId++);
		const node	= new Node(id, type, value);
		graph.set(id, node);
		return node;
	}
	// Seeds the top-level (and, transitively, each function body's) state chain. Without a real anchor
	// here, any effect appearing before the first function_decl -- or a program with no function_decl
	// wrapper at all, which is what applyGlobalCodeMotion/Output's own reconstruction currently
	// assume -- has nothing valid to thread its first state edge from.
	let end: Node = makeNode('effect', 'PROGRAM_START');
	const programStart = end;

	// True when the path just walked (a branch, a case body) never falls through to its own lexical
	// successor -- it broke, continued, or returned. Tracked the same way `end`/`scope` are (reset
	// before each branch, read right after), and consulted only by 'if' (see below) to decide whether
	// a branch needs a real structural gamma even with no call in it, and to propagate "exited" to its
	// own enclosing branch when EVERY path out of it exited.
	let exited = false;

	// True specifically when `exited` was caused by a `break` (never continue/return/throw), tracked
	// the exact same way `exited` itself is. The distinction matters for reconcileVariables: a `break`
	// targets something (an enclosing loop, or a switch's own break_scope) whose exit point is real
	// code that reads a reassigned variable back through the graph, so its value needs to survive
	// into the merge. continue/return/throw don't -- their targets (the next loop iteration, the
	// function's own caller, an exception handler) are handled entirely by the real, already-forced-
	// printed statement and ordinary JS runtime semantics; threading their value through a graph-level
	// merge too is not just unnecessary but actively wrong, confusing GCM's own scheduling (confirmed
	// empirically -- see reconcileVariables's own comment for the concrete failure).
	let brokeOut = false;

	// One entry per enclosing LOOP (never `switch` -- it establishes no continue target of its
	// own, so it's transparent here, same as it is to a real `continue` at runtime), holding a
	// for-loop's own `update` expression, or undefined for while/do-while. Consulted only by
	// 'continue': a for-loop's `update` runs after the body on the NORMAL path (folded directly
	// into buildLoop's body, see 'for' below), but `continue` -- lowered onto the same while-shaped
	// graph while/do-while use -- would otherwise skip it entirely (a bare `continue;` inside a
	// `while(true){body;update;}`-shaped loop jumps straight to the re-test, past anything after it
	// in the same block, exactly like real JS's own while-continue does). Real `for`-loop semantics
	// need `update` to still run first, so `continue` re-walks a FRESH clone of it before creating
	// its own marker -- not the original node (already walked once, for the normal path), which
	// would double-process the same expression object.
	const loopUpdateStack: (Expr | undefined)[] = [];

	function makeExprNode(expr: Expr, type: string = expr.type) {
		const node = makeNode(type, expr);
		expnodes.set(expr, node);
		return node;
	}
	function getExprNode(expr: Expr) {
		if (expr.type === 'identifier') {
			const found = scope.get(expr.name);
			if (found) {
				// See capturedRead's own comment on Node: a read reaching outside the function it's
				// declared in must never be statically inlined, since the reading function might run
				// zero, one, or many times, each needing to see whatever the variable ACTUALLY holds
				// at that point, not whatever it held when declared.
				if (!scope.isLocalToCurrentFunction(expr.name))
					found.capturedRead = true;
				return found;
			}
			let ext = externalNodes.get(expr.name);
			if (!ext) {
				ext = makeNode('var', expr.name);
				externalNodes.set(expr.name, ext);
			}
			return ext;
		}
		const node = expnodes.get(expr);
		if (!node)
			throw new Error(`missing node for ${JSON.stringify(expr)}`);
		return node;
	}
	function getState(): State {
		return { scope, end, exited, brokeOut };
	}
	function setState(_scope: Scope, _end: Node, _exited = false, _brokeOut = false) {
		scope		= _scope;
		end			= _end;
		exited		= _exited;
		brokeOut	= _brokeOut;
	}

	function connectEnd(effect: Node) {
		connectValue(end, 0, effect, 0);
		end = effect;
	}


	// Walks the state chain backwards from `tail` to `boundary`, ignoring MUTATION_MARKER nodes, to
	// check whether a REAL effect (a call) happened along the way. Used to decide whether an if/else
	// branch needs a structural state-merge (a gamma wrapping actual code) -- a branch that only
	// reassigned variables (no calls) already has its value fully captured by the per-variable named
	// gamma as a ternary; comparing raw `end` values directly would treat the ordering markers
	// reassignments now thread through as if they were real divergence, wrapping empty branches in a
	// pointless `if (...) {} else {}`.
	function hasRealEffect(tail: Node, boundary: Node): boolean {
		let cur = tail;
		while (cur !== boundary) {
			if (!(cur.type === 'effect' && cur.value === 'MUTATION_MARKER'))
				return true;
			const pred = cur.inputs[0];
			if (!pred)
				return true; // shouldn't happen; treat conservatively as a real divergence
			cur = graph.get(pred.nodeId)!;
		}
		return false;
	}
	// A reassignment (`x = ...`, `x += ...`, `++x`) is an observable mutation, exactly like a call --
	// but unlike a call, it was never threaded through the state chain, so nothing stopped a later
	// call (or var_decl) that reads the SAME binding from being scheduled/printed as if it ran
	// BEFORE the reassignment, silently reading the wrong (post-mutation) value. This threads a
	// marker into the state chain the same way a call does, and hangs the reassignment node off it
	// (a scheduling-only edge on the node's own unused port 2 -- binary uses 0/1 for its real
	// operands, unary uses only 0) so GCM can never place the reassignment earlier than its real
	// position in program order, without needing the reassignment ITSELF to become a state anchor
	// (which would conflict with port 0 already being its left/operand slot).
	// Orders a rebind (a declaration OR a reassignment) after whatever the state chain currently is,
	// same as a call would be.
	//
	// A tighter version is possible in principle: a reassignment only needs to be ordered relative to
	// an effect that ACTUALLY read the value it's replacing (for a true local, un-captured variable,
	// that's knowable from the call site alone -- is this variable one of its arguments -- with no
	// purity analysis needed), not every effect since the start of the program. That was tried here
	// and reverted: connecting the reassignment directly to that specific prior effect's node doesn't
	// just constrain ORDER, it also constrains DEPTH (scheduleEarly computes "earliest = deepest among
	// my inputs"), so a reassignment that should run unconditionally on every loop iteration got
	// pulled INSIDE a conditional branch the effect happened to be nested in -- turning
	// `if (i) { g(i); } i = i + 1;` into `if (i) { g(i); i = i + 1; }`, an infinite loop when `i` is
	// ever falsy. The correct target is the merge point the effect's branch eventually rejoins, not
	// the effect itself; computing that in general is real additional work, not a small tweak, so it's
	// left for later rather than risk a repeat of that bug now.
	function threadMutation(node: Node) {
		const marker = makeNode('effect', 'MUTATION_MARKER');
		connectValue(marker, 0, node, 2);
		connectEnd(marker);
	}
	// The single place a name becomes (re)bound to a node: tags it for Output, updates scope, and
	// orders it -- all three always travel together, so they live in one place instead of being
	// duplicated (and easy to accidentally skip one of) at every call site that rebinds a variable.
	function rebindVar(name: string, node: Node, isDeclaration = false) {
		node.boundName = name;
		if (isDeclaration)
			scope.create(name, node);
		else
			scope.set(name, node);
		threadMutation(node);
	}

	// Shared by 'while' and 'do_while': both are the same mu/theta loop-carried-variable machinery,
	// differing only in whether the test is read BEFORE the body (while) or AFTER it (do_while --
	// the body always runs at least once, using whatever the mu's INITIAL value is on the first
	// pass). `recurse` is passed in explicitly since it's only available inside the walkB callback
	// this is called from, not at BuildVSDG's own top level where the other shared helpers live.
	function buildLoop(recurse: RecurseB, test: Expr, body: Statement, isDoWhile: boolean, forUpdate?: Expr) {
		const preLoop	= getState();
		const muEnd		= makeNode('mu');
		if (isDoWhile)
			muEnd.loopKind = 'do';
		const muScope	= new ScopeMu(scope, makeNode, muEnd, () => currentFunctionEntry);
		scope	= muScope;
		connectEnd(muEnd);

		loopUpdateStack.push(forUpdate);
		let testNode: Node;
		if (isDoWhile) {
			exited = false;
			brokeOut = false;
			recurse(body);
			recurse(test, 'expression');
			testNode = getExprNode(test);
		} else {
			recurse(test, 'expression');
			testNode = getExprNode(test);
			exited = false;
			brokeOut = false;
			recurse(body);
		}
		loopUpdateStack.pop();

		connectValue(end, 0, muEnd, 1); // Slot 1 = Feedback loop

		const stateTheta = makeNode('theta');
		connectValue(muEnd, 0, stateTheta, 0);		// Slot 0 = State predecessor (the loop)
		connectValue(testNode, 0, stateTheta, 1);	// Slot 1 = Loop termination condition
		end = stateTheta;

		scope = preLoop.scope;
		for (const [name, muNode] of muScope.muNodes) {
			const node = muScope.bindings.get(name)!;
			connectValue(node, 0, muNode, 1);		// Slot 1 = Feedback loop

			const theta = makeNode('thetaValue', name);
			connectValue(testNode, 0, theta, 0);	// Slot 0 = Condition
			connectValue(muNode, 0, theta, 1);		// Slot 1 = Value to pass out
			connectValue(stateTheta, 0, theta, 2);	// Scheduling-only anchor, see ScopeMu's own
			scope.set(name, theta);
		}
		// The loop AS A WHOLE always falls through to whatever follows it (from the enclosing
		// context's perspective) regardless of whether break/continue happened inside its body.
		exited = false;
		brokeOut = false;
	}

	// Shared by 'if' and 'switch' (each of switch's cases is structurally its own binary branch --
	// "hit or matched" vs "not yet", chained forward into the next case exactly the way an if/else
	// chain already is): resets scope/end/exited to `parent`, walks one branch's own content, and
	// captures the resulting state -- the exact setup/teardown 'if' used to repeat once per side.
	function walkBranch(parent: State, walk: () => void) {
		setState(new Scope(parent.scope), parent.end);
		walk();
		return getState();
	}

	// The STATE-level half of reconciling two branches: does either side need a real structural
	// gamma (a call, or an exit -- see 'if's own original comment for why), or does state simply
	// continue unchanged past a branch that only reassigned variables. Sets `end`/`exited` for
	// whatever comes next -- the next case in a switch chain, or whatever follows the whole if.
	function mergeState(parent: State, test: Node, trueState: State, falseState: State): Node | undefined {
		if (trueState.exited || falseState.exited || hasRealEffect(trueState.end, parent.end) || hasRealEffect(falseState.end, parent.end)) {
			const gamma = makeNode('gamma');
			connectValue(parent.end, 0, gamma, 0);		// Slot 0 = State predecessor
			connectValue(test, 0, gamma, 1);				// Slot 1 = Condition
			connectValue(trueState.end, 0, gamma, 2);		// Slot 2 = True State
			connectValue(falseState.end, 0, gamma, 3);	// Slot 3 = False State
			end = gamma;
			// This branch pair only counts as "exited" (to whatever encloses it) when BOTH sides did --
			// an implicit empty else (or, for a switch case, simply not matching) always falls through,
			// so the non-existent side's own state already correctly reports exited: false.
			exited = trueState.exited && falseState.exited;
			// Propagated the same way: only true when BOTH sides exited AND both did so via break
			// (mixed kinds -- e.g. one side breaks, the other returns -- fall back to false here, same
			// as reconcileVariables's own "both exited" case: nothing downstream is reachable from
			// EITHER path there anyway, so which value it "would" merge to is moot).
			brokeOut = exited && trueState.brokeOut && falseState.brokeOut;
			return gamma;
		}
		// No real effect in either branch: the reassignment(s), if any, are already fully
		// captured by reconcileVariables's own per-variable named gamma (a pure ternary needs no
		// structural if/else). `end` must still be reset -- left alone, it would dangle off
		// whichever branch's mutation-marker chain was walked last, instead of the state that
		// actually continues past this (structurally absent) branch.
		end = parent.end;
		exited = trueState.exited && falseState.exited;
		brokeOut = exited && trueState.brokeOut && falseState.brokeOut;
		return undefined;
	}

	// True if `name` is currently loop-carried: reassigning it needs a REAL, PRINTED, MUTATED
	// variable (not just a value edge folded into a ternary), because a `while`'s NEXT iteration
	// sees the update only through the ACTUAL runtime variable -- unlike a one-shot merge (if/
	// switch), there's no graph edge connecting one iteration's value to the next one's read.
	// ScopeMu.get() lazily creates the mu binding the first time something inside the loop reads a
	// name bound further out; reconcileVariables always calls scope.get(name) for both sides before
	// this is checked, so by now the binding (if this reassignment would ever trigger one) already
	// exists. The NEAREST ScopeMu ancestor is always the one that would own it -- its own get()
	// override intercepts before ever delegating further out -- so there's no need to walk past it.
	function isLoopCarried(name: string): boolean {
		for (let s: Scope | null = scope; s; s = s.parent) {
			if (s instanceof ScopeMu)
				return s.muNodes.has(name);
		}
		return false;
	}

	// The VALUE half: per-variable reconciliation of everything either branch reassigned.
	function reconcileVariables(parent: State, test: Node, trueState: State, falseState: State) {
		scope = parent.scope;
		const divergedVariables = new Set([
			...trueState.scope.bindings.keys(),
			...falseState.scope.bindings.keys()
		]);
		for (const name of divergedVariables) {
			const trueVal	= trueState.scope.get(name)!;
			const falseVal	= falseState.scope.get(name)!;

			// If the values ended up different, create the Gamma stitch
			if (trueVal !== falseVal) {
				// Exactly one branch exited. Two different cases, both starting from "the exited
				// branch's own value must print as a real statement, exactly where it is" (forcedPrint
				// -- an assignment right before a break/continue/return/throw still has to run, in
				// place, regardless of what happens to its value afterward):
				//
				//  - continue/return/throw: their target (the next loop iteration, the function's own
				//    caller, an exception handler) is handled entirely by that forced-printed statement
				//    plus ordinary JS runtime semantics -- nothing downstream ever reads this specific
				//    value back through the GRAPH, so merging it in here would be not just unnecessary
				//    but actively wrong (confirmed empirically: it corrupts GCM's own scheduling,
				//    hoisting things out of enclosing loops entirely). "After" is reachable only via
				//    the other (live) branch, so that's the whole merge -- no gamma needed.
				//
				//  - break: unlike the above, its target (an enclosing loop, or a switch's own
				//    break_scope) has a REAL exit point that other code reads `name` through via the
				//    graph (the loop's own theta export, or whatever follows the switch) -- so this
				//    value DOES need to be part of the merge after all, falling through to the same
				//    gamma-building below the live (non-exited) branch uses.
				const exitedState = trueState.exited ? trueState : falseState;
				if (trueState.exited !== falseState.exited && !exitedState.brokeOut) {
					const exitedVal = trueState.exited ? trueVal : falseVal;
					if (exitedVal.boundName === name)
						exitedVal.forcedPrint = true;
					scope.set(name, trueState.exited ? falseVal : trueVal);
					continue;
				}

				// Each branch's own PLAIN REASSIGNMENT node (if any) picked up boundName === name
				// while it was walked as if it might be the final answer -- it's being superseded by
				// the gamma now, so it's no longer really "x" (only the gamma is); left tagged, it
				// would print unconditionally AND the gamma would resolve its operand back to the
				// name it's merging, i.e. print `x = x ? x : x;` instead of the actual branch value.
				// EXCEPT the side that broke out (if either did): it still needs forcedPrint, same as
				// above, and forcedPrint only works through emitNamedSlot's own print path, which
				// requires slotName() (boundName) to stay set -- so it's deliberately left untouched.
				// A var_decl's OWN wrapper node must NEVER have its boundName cleared either way, even
				// when it ends up as a merge candidate (e.g. `x` unchanged on one path falls through
				// to its own declaration node as that path's value): declaring the variable is a
				// separate concern from which value merges where, and it's the ONLY thing that ever
				// prints `let x = ...;` at all.
				const trueExitedViaBreak	= trueState.exited && !falseState.exited && trueState.brokeOut;
				const falseExitedViaBreak	= falseState.exited && !trueState.exited && falseState.brokeOut;

				// forcedPrint is only actually NECESSARY when `name` is loop-carried (see
				// isLoopCarried's own comment) -- a one-shot merge (if/switch, no enclosing loop) has
				// no "next iteration" that needs a real, mutated variable to see the update through;
				// the value is just as correctly represented purely as a graph edge into the
				// (neverMaterialize) merge below, exactly like an ordinary non-exited branch's
				// reassignment already is. switchInternal (see resolveNode's own check) is the OTHER
				// reason to stay forced regardless of loop-carriedness: switch's own bookkeeping
				// (hit=true;) needs its boundName kept ONLY in exactly the situations that used to
				// force it unconditionally (trueExitedViaBreak) -- an ordinary, non-exiting case (a
				// fall-through with no break) must still clear it exactly like before, or its
				// per-case merge stops collapsing to a bare name the way it always has.
				if (trueExitedViaBreak && trueVal.boundName === name && (trueVal.switchInternal || isLoopCarried(name)))
					trueVal.forcedPrint = true;
				else if (trueVal.boundName === name && !trueVal.declKind)
					trueVal.boundName = undefined;

				if (falseExitedViaBreak && falseVal.boundName === name && (falseVal.switchInternal || isLoopCarried(name)))
					falseVal.forcedPrint = true;
				else if (falseVal.boundName === name && !falseVal.declKind)
					falseVal.boundName = undefined;

				// When one side broke out, ITS operand (and possibly the live side's, if that's a
				// var_decl, never cleared above) still carries boundName === name -- printing the
				// merge gammaValue itself under that same name would be circular (see
				// neverMaterialize's own comment on Node) -- neverMaterialize gets the "never print
				// under this name" outcome directly, without needing to leave it unnamed to get there
				// (which, back when gammaValue and the state gamma shared one type tag, is exactly
				// what mis-scheduled it as a parentless root block -- found and fixed the hard way,
				// and part of why they're two distinct tags now).
				const gamma = makeNode('gammaValue', name);
				if (trueExitedViaBreak || falseExitedViaBreak)
					gamma.neverMaterialize = true;
				connectValue(test, 0, gamma, 0); 		// Condition
				connectValue(trueVal, 0, gamma, 1);		// True path
				connectValue(falseVal, 0, gamma, 2);	// False path

				// Commit the Gamma node value directly to the parent scope
				// This ensures downstream code after the branch sees the merged result!
				scope.set(name, gamma);
			}
		}
	}

	// A method/get/set/static_block's own independent function-scoped subgraph -- own entry/return
	// anchor pair, own scope chained to the enclosing one -- reusing the exact same machinery a
	// top-level function_decl gets (see its own comment), including connecting entryNode into the
	// outer state chain: not because the BODY runs at this point (it doesn't -- a method body runs
	// only when called, later; a static block does run once, at class-definition time, but that's
	// already correctly ordered via the class's own anchor node regardless), but because
	// applyGlobalCodeMotion's own region-boundary logic (regionRootOf, in scheduleLate) needs
	// entryNode's own block to nest under whichever region it's declared in, so anything genuinely
	// INSIDE this function (reached via the marker chain, not this edge) is correctly recognized as
	// a separate region rather than folded into the caller's own. Multiple class members' entry
	// nodes end up sharing the same `outer.end` predecessor here (buildClassMember never advances
	// it between members) -- an ordinary multi-consumer output edge, not a conflict.
	function buildFunctionBody(recurse: RecurseB, params: JS.Params<TS.Type> | undefined, body: Expr | Statement[]): Node {
		const outer			= getState();
		const entryNode		= makeNode('function_decl');
		const returnNode	= makeNode('effect', 'RETURN_ANCHOR');
		entryNode.returnNodeId = returnNode.id;
		connectValue(outer.end, 0, entryNode, 0);

		// See the top-level function_decl case's own comment on its matching bodyStart: gives the
		// body its own, unambiguous region root for regionRootOf (applyGlobalCodeMotion) to find --
		// entryNode's own block isn't safe to use for that (see FUNCTION_BODY_START's own comment).
		const bodyStart = makeNode('effect', 'FUNCTION_BODY_START');
		connectValue(entryNode, 0, bodyStart, 0);


		const fnScope = new Scope(scope);
		fnScope.isFunctionBoundary = true;

		// A destructured param's own hidden temp binding (its own opaque 'var' node -- externally
		// provided, no input edge, exactly like an ordinary named param) is created below, same as
		// any other param, but the flat var_decls that destructure it can't be recursed until the
		// function's own state chain (fnScope/bodyStart) is live -- collected here, emitted right
		// after setState, before the real body statements (so they're the first things the body
		// actually does, matching the parameter's own left-to-right binding order).
		const pendingParamPatterns: [JS.BindingTarget, string][] = [];
		if (params) {
			// Wire incoming output ports from the entry node directly to parameter bindings.
			// Each param gets its own node (port 0 = State, so params occupy port index + 1);
			let port = 1;
			function addParam(key: JS.BindingTarget) {
				if (typeof key === 'string') {
					const paramNode = makeNode('var', key);
					connectValue(entryNode, port++, paramNode, 0);
					fnScope.create(key, paramNode);
				} else {
					const tempName = `__destructure${nextId++}`;
					const paramNode = makeNode('var', tempName);
					connectValue(entryNode, port++, paramNode, 0);
					fnScope.create(tempName, paramNode);
					pendingParamPatterns.push([key, tempName]);
					(entryNode.destructuredParams ??= new Map()).set(key, tempName);
				}

			}
			params.params.forEach(p => addParam(p.key));
			if (params.rest)
				addParam(params.rest.key);
		}

		setState(fnScope, bodyStart);

		// Set for the body's own walk, restored after -- a 'this'/'super' created anywhere inside
		// (including a nested function/method) gets stamped with the INNERMOST entryNode, not
		// necessarily the one real lexical `this` in JS would resolve to for an arrow function
		// nested here (arrows share the ENCLOSING `this`, but go through this exact same
		// buildFunctionBody path, with no distinction made). Still strictly better than the prior
		// zero-anchoring: it keeps a this-derived hoisted value inside SOME real function's region
		// instead of escaping to the top level; getting the precise arrow-lexical-this floor right
		// is a separate, not-yet-hit gap.
		const outerFunctionEntry = currentFunctionEntry;
		currentFunctionEntry = entryNode;
		// A destructured param's own flat var_decls are the first things the body actually does,
		// matching the parameter's own left-to-right binding order -- walked here, not before
		// currentFunctionEntry is set, for the same reason the real body statements need it set
		// first (a 'this'/'super' or muValue anywhere in a default value needs the right floor).
		for (const [key, tempName] of pendingParamPatterns)
			for (const stmt of patternBindings('let', key, Identifier(tempName)))
				recurse(stmt, 'statement');
		if (Array.isArray(body)) {
			for (const stmt of body)
				recurse(stmt, 'statement');
			connectValue(makeNode('literal', undefined), 0, returnNode, 1);
		} else {
			recurse(body, 'expression');
			connectValue(getExprNode(body), 0, returnNode, 1);
		}
		currentFunctionEntry = outerFunctionEntry;

		connectValue(end, 0, returnNode, 0);

		// closeAndFlush propagates a CAPTURED variable's own reassignment back into the caller's
		// own bindings, so a later read resolves to it by name (see the top-level function_decl
		// case's own comment for the full reasoning, and why this is now safe: forcedPrint plus
		// scheduleLate's own region-boundary exclusion together keep the reassignment correctly
		// printed INSIDE this function, never inlined away and never dragged outside it).
		fnScope.closeAndFlush();
		setState(outer.scope, outer.end, outer.exited, outer.brokeOut);
		return entryNode;
	}

	// Heritage and every member's own computed key are real expressions that can call out and
	// reference outer values -- resolved through VSDG (rather than left in the OLD generic,
	// print-blind `process(s)` walk) so a referenced outer variable's own declaration doesn't get
	// its value silently inlined/orphaned away. Each resolved value is wired into `anchor` (the
	// class's own 'effect'/'passthru' node, created by the caller before this runs) at its own
	// port, ports 1.. (0 is the state predecessor, same convention 'call'/'new'/'jsx' already use)
	// -- a REAL graph edge, not just a value recorded in classInfo for printing: without one,
	// hasRealConsumer sees no consumer at all for it (classInfo's own NodeId references are
	// invisible to ordinary graph-edge-based consumer counting), so its value looks unused --
	// exactly the bug this whole pass exists to fix (see Output's own rebuildClass, which reads
	// classInfo back to splice the resolved values into the printed member list).
	function buildClass(recurse: RecurseB, anchor: Node, s: { superClass?: JS.Expr<any>; body: JS.ClassMember<any>[] }): NonNullable<Node['classInfo']> {
		let port = 1;
		let superClassNodeId: NodeId | undefined;
		if (s.superClass) {
			recurse(s.superClass, 'expression');
			const node = getExprNode(s.superClass);
			connectValue(node, 0, anchor, port++);
			superClassNodeId = node.id;
		}
		return {
			superClassNodeId,
			// Two ports per member (key, static field value) -- unused ones (a non-computed key, a
			// non-static/non-field member) just go unclaimed, harmless.
			members: s.body.map(m => {

				// A computed member key (`[expr]: ...`) is a real expression that can call out -- resolved
				// through VSDG like any other, so a class's printed key correctly reflects VSDG's own
				// resolution instead of the raw, un-walked source (same reasoning as switchCases's own
				// testNodeId). A plain (non-computed) key is just a name, nothing to walk. Wired into `anchor`
				// at the next free port (see buildClass's own comment for why this matters, not just resolving
				// the value): without a REAL graph edge, this is a "phantom" reference invisible to
				// hasRealConsumer, so the key's own value looks unused -- silently inlining/orphaning away
				// whatever variable it reads, and (if it's a real effect) getting printed a second time,
				// standalone, as if nothing consumed its result.
				let keyNodeId;
				if ('key' in m && typeof m.key !== 'string') {
					const expr = m.key.computed;
					recurse(expr, 'expression');
					const node = getExprNode(expr);
					connectValue(node, 0, anchor, port++);
					keyNodeId = node.id;
				}

				switch (m.type) {
					case 'method':
					case 'get':
					case 'set':
						return m.body ? { keyNodeId, entryNodeId: buildFunctionBody(recurse, m, m.body).id } : { keyNodeId };
					case 'static_block':
						return { entryNodeId: buildFunctionBody(recurse, undefined, m.body).id };
					case 'field': {
						if (!m.value)
							return { keyNodeId };
						if (m.modifiers?.includes('static')) {
							// A static field's own initializer runs once, at class-definition time, same as
							// heritage/keys -- resolved and threaded directly into the outer (class-anchored)
							// chain, wired into `anchor` at its own port (port+1 -- port itself is the key's,
							// see buildClassKey) for the same reason heritage/keys need one: without a real
							// graph edge, hasRealConsumer sees no consumer for it at all (this is a "phantom"
							// reference, resolved later via valueNodeId, not a graph edge on its own).
							recurse(m.value, 'expression');
							const valueNode = getExprNode(m.value);
							connectValue(valueNode, 0, anchor, port++);
							return { keyNodeId, valueNodeId: valueNode.id };
						}
						// An INSTANCE field's own initializer runs once per `new`, not at class-definition
						// time -- threading it into the outer chain directly (like a static field) would be
						// exactly the same bug class as a method body before it got its own entry/bodyStart
						// isolation: something that runs repeatedly, at an unknown future point, forced into
						// a single, one-time position in the class's own definition sequence. Reuses
						// buildFunctionBody wholesale (own entry/bodyStart/return-anchor pair, no params),
						// passing `m.value` directly as an expression body (the same shape an
						// expression-bodied arrow uses) -- its own resolved value ends up on returnNode's
						// port 1 directly, no synthetic `return` statement/EARLY_RETURN_MARKER involved.
						// Output's own resolveFieldInitializer (a second callback, alongside
						// reconstructFunctionBody -- see its own comment) reads exactly that port. A
						// captured variable read or reassigned from inside the initializer gets the same
						// capturedRead/forcedPrint treatment as anywhere else (isLocalToCurrentFunction
						// doesn't care how the function boundary was built).
						return { keyNodeId, entryNodeId: buildFunctionBody(recurse, undefined, m.value).id };
					}
					default:
						// 'index_signature' has no runtime code at all (a type-only member).
						return { keyNodeId };
				}

			}),
		};
	}

	walkB(ast,
		(s, process, recurse) => {
			switch (s.type) {
				case 'function_decl':
					if (s.body) {
						end = buildFunctionBody(recurse, s, s.body);
						end.value = s;
					}
					return false;

				case 'return': {
					// Same shape as 'throw' below: the marker carries its own value directly at port 1
					// (when there is one -- `return;` with no argument leaves it unconnected), rather
					// than threading it through scope the way an ordinary variable would. A scope-based
					// channel can't represent "this branch hasn't returned yet, keep going" for a
					// branch that falls through normally -- there's no real VALUE to merge it against
					// at the point the if/else reconciles, only "wait and see what happens later".
					// Setting `exited = true` (like break/continue/throw) sidesteps that entirely: it
					// makes 'if' build a real gamma/branch structure around this path (so the marker,
					// and the `return` statement it prints as, land inside the correct branch) without
					// ever needing to merge a VALUE here at all -- each return prints itself, in place,
					// wherever it actually is.
					if (s.argument)
						recurse(s.argument, 'expression');
					const marker = makeNode('effect', 'EARLY_RETURN_MARKER');
					connectEnd(marker);
					if (s.argument)
						connectValue(getExprNode(s.argument), 0, marker, 1);
					exited = true;
					return false;
				}
				case 'throw': {
					// Only an EXPLICIT throw is modeled -- an ordinary call inside a `try` that
					// might itself throw isn't represented as a control-flow edge to `catch` at
					// all (see the design note on BuildVSDG's 'try' case for why that's fine for
					// output correctness: nothing here reorders a `try` body's own statements
					// relative to each other, so real JS's own exception routing at runtime is
					// unaffected either way).
					recurse(s.argument, 'expression');
					const marker = makeNode('effect', 'THROW_MARKER');
					connectEnd(marker);
					connectValue(getExprNode(s.argument), 0, marker, 1);
					exited = true;
					return false;
				}
				case 'break': {
					// A labeled break can target an OUTER loop/switch, not just the nearest enclosing
					// one -- not supported here (no label-aware target tracking exists), so flag it
					// rather than silently mistargeting.
					if (s.label)
						console.log(`not handling labeled break`);
					// No target-tracking needed: unlike a real jump, this doesn't need to know WHICH
					// loop/switch it belongs to. Its only two jobs are (1) mark `exited` so enclosing
					// `if`s correctly treat this branch as not falling through -- which is what keeps
					// whatever textually follows (more of the loop body, more switch cases) from being
					// wired up as if it always runs -- and (2) leave a marker in the state chain so
					// Output's own emitLocalStatements prints a literal `break;` here. The printed
					// statement itself is what real JS routes to the nearest enclosing loop/switch at
					// runtime.
					connectEnd(makeNode('effect', 'BREAK_MARKER'));
					exited = true;
					brokeOut = true;
					return false;
				}
				case 'continue': {
					if (s.label)
						console.log(`not handling labeled continue`);
					// A real `for` loop's `update` runs even when the body `continue`s -- only the
					// REST of the body is skipped. This graph is lowered onto the same while-shaped
					// mu/theta machinery `while` uses (buildLoop folds `update` into the tail of the
					// NORMAL body path, see the 'for' case below), where a bare `continue;` would
					// otherwise skip `update` entirely (jumping straight to the re-test, past
					// anything else in the same block, exactly like a real while-loop's own continue
					// does) -- so re-walk a FRESH clone of `update` first, right here, before the
					// continue marker. The nearest ENCLOSING LOOP is what matters (switch pushes
					// nothing onto loopUpdateStack, so it's correctly transparent here, same as it is
					// to a real `continue` at runtime -- a `continue` inside a switch case still
					// targets the loop the switch itself sits in, never the switch).
					const forUpdate = loopUpdateStack[loopUpdateStack.length - 1];
					if (forUpdate)
						recurse(structuredClone(forUpdate), 'expression');
					connectEnd(makeNode('effect', 'CONTINUE_MARKER'));
					exited = true;
					return false;
				}
				case 'var_decl': {
					// Each declarator's own initializer is walked (via `recurse`, not a blanket
					// `process(s)` up front) THEN immediately bound into scope, one at a time -- not
					// all initializers first, then all bindings after. Real `let`/`const`/`var`
					// declarators in ONE statement bind strictly left to right, so `e`'s own
					// initializer in `let i = off, e = i + len;` must see `i` ALREADY in scope. With
					// the old "walk everything, then bind everything" order, `e`'s own read of `i`
					// happened before `i` had a scope entry at all, silently falling back to the
					// undeclared-external-name path -- a real, disconnected placeholder node sharing
					// only the STRING "i", not a real graph edge to i's own declaration. Printing
					// still looked right (name-based resolution doesn't care which node it is), but
					// anything that actually needs the real edge (GCM scheduling, ordering hints) had
					// nothing to find (found on real code: `let e = i + len; let i = off;`, reading
					// `i` before its own declaration -- see the tracked plan for the two GCM-side
					// fixes tried and reverted before finding this, the actual root cause).
					for (const v of s.declarations) {
						if (typeof v.name === 'string') {
							if (v.init)
								recurse(v.init, 'expression');
							// A dedicated wrapper node per declared variable, rather than aliasing directly
							// to the initializer's node: without it, `let x = 5; let y = 5;` would bind BOTH
							// names to the very same literal node (or, worse, to whatever a later CSE pass
							// merges it with), so codegen would have no way to tell which name to print, and
							// Output never had a declaration statement to emit for a local in the first place.
							const varNode = makeNode('var', v.name);
							if (v.init)
								connectValue(getExprNode(v.init), 0, varNode, 0);
							varNode.declKind = s.kind;
							varNode.typeAnnotation = v.typeAnnotation;
							// A declaration is an observable event too, same as a reassignment: `resolveNode`
							// prints ANY 'var' node as a bare `Identifier(name)` unconditionally (it has to --
							// that's also how parameters, which really do pre-exist, are read), so nothing
							// about reading it enforces "the declaration was already emitted". Without this,
							// GCM was free to schedule `let a = 1;`'s own statement AFTER code that already
							// reads `a` (e.g. an `if (a)` test right after it), since both just look like
							// ordinary data to the scheduler.
							rebindVar(v.name, varNode, true);
						} else if (v.init) {
							// Bind the real initializer to a hidden temp exactly once (patternBindings'
							// own contract -- it may read valueExpr multiple times, once per element/
							// property, so it must never be handed an effectful expression directly),
							// then desugar the pattern into flat var_decls reading off that temp, each
							// recursed through the SAME statement dispatch as any ordinary declarator --
							// so a nested pattern (`const [a, ...{length}] = x;`) is handled for free by
							// simply re-entering this exact case.
							const tempName = `__destructure${nextId++}`;
							recurse(JS.VarDecl<TS.Type>(s.kind, JS.Var<TS.Type>(tempName, v.init)) as Statement, 'statement');
							for (const stmt of patternBindings(s.kind, v.name, Identifier(tempName)))
								recurse(stmt, 'statement');
						} else {
							console.log(`not handling destructured declarator with no initializer`);
						}
					}
					return false;
				}
					
				case 'block': {
					scope = new Scope(scope);
					process(s);
					scope = scope.closeAndFlush()!;
					return false;
				}
				case 'if': {
					recurse(s.test, 'expression');
					const test		= getExprNode(s.test);
					const parent	= getState();
					// `recurse`, not `process`, for each branch: this walks s.consequent/s.alternate
					// THEMSELVES through the hook (so a bare, non-block consequent like `if (x) let y
					// = 1;` still gets its var_decl/if/while handling); `process` only walks a node's
					// own children, never the node it's given.
					const trueState		= walkBranch(parent, () => recurse(s.consequent));
					const falseState	= walkBranch(parent, () => { if (s.alternate) recurse(s.alternate!); });
					mergeState(parent, test, trueState, falseState);
					reconcileVariables(parent, test, trueState, falseState);
					return false;
				}

				case 'while':
					buildLoop(recurse, s.test, s.body, false);
					return false;

				case 'do_while':
					// The body runs BEFORE the test (using the mu's INITIAL value on the first
					// pass), unlike `while` -- see buildLoop's own comment.
					buildLoop(recurse, s.test, s.body, true);
					return false;

				case 'for': {
					// `for await...of` needs the ASYNC iterator protocol (Symbol.asyncIterator, and
					// awaiting each `.next()`) -- `await` has no dedicated case anywhere in this file
					// at all (only 'yield' does), so it's left on the same "not attempted" fallback
					// for-of/for-in used to sit on entirely.
					if (s.kind === 'of await') {
						console.log(`not handling for-${s.kind}`);
						return process(s);
					}
					if (s.kind !== 'normal') {
						// Desugar to the real (synchronous) iterator protocol, reusing buildLoop's
						// existing while-shaped mu/theta/break/continue machinery entirely as-is (same
						// idea as the C-style 'for' desugar just below):
						//   const __iterN = <iterable>[Symbol.iterator]();
						//   while (true) {
						//     const __rN = __iterN.next();
						//     if (__rN.done) break;
						//     <binding> = __rN.value;
						//     <body>
						//   }
						// `for...in` reuses the exact same shape over `Object.keys(<iterable>)` instead of
						// the iterable itself -- an accepted simplification (own enumerable keys only, not
						// the full prototype-chain walk real for-in does; matches this file's existing
						// "partial fidelity is fine, silent wrongness is not" bar elsewhere, e.g. class
						// printing). No `forUpdate` (unlike the C-style 'for' below): there's no separate
						// update step distinct from the body's own natural top-of-loop advance-and-check,
						// so an ordinary `continue` (falling through to the top of the while's own body)
						// already re-runs the advance for the next iteration, exactly like a real for-of's
						// continue should. The bound name/target (simple identifier, member, index, or a
						// destructured pattern) is threaded through the SAME existing var_decl/assignment
						// machinery a normal declaration or reassignment already uses -- including its
						// real destructuring support (patternBindings), so a destructured loop variable
						// (`for (const [k, v] of entries)`) is handled for free, with no code here needing
						// to know or care.
						const suffix		= String(nextId++);
						const iterName		= `__iter${suffix}`;
						const resultName	= `__r${suffix}`;
						const iterable		= s.kind === 'in' ? JS.Call<TS.Type>(JS.Member<TS.Type>(Identifier('Object'), 'keys'), [s.right]) : s.right;
						recurse(JS.VarDecl<TS.Type>('const', JS.Var<TS.Type>(iterName,
							JS.Call<TS.Type>(JS.Index<TS.Type>(iterable, JS.Member<TS.Type>(Identifier('Symbol'), 'iterator')), [])
						)), 'statement');

						const value = JS.Member<TS.Type>(Identifier(resultName), 'value');
						buildLoop(recurse, Literal(true), JS.Block<TS.Type>(
							JS.VarDecl<TS.Type>('const', JS.Var<TS.Type>(resultName, JS.Call<TS.Type>(JS.Member<TS.Type>(Identifier(iterName), 'next'), []))),
							{ type: 'if', test: JS.Member<TS.Type>(Identifier(resultName), 'done'), consequent: { type: 'break' } } as JS.Statement<TS.Type>,
							(s.init.type === 'var_decl'
								? JS.VarDecl<TS.Type>(s.init.kind, JS.Var<TS.Type>(s.init.declarations[0].name, value))
								: JS.Expression<TS.Type>({ type: 'binary', operator: '=', left: s.init, right: value } as Expr)) as JS.Statement<TS.Type>,
							s.body
						), false);
						return false;
					}
					// 1. Run init exactly once, before the loop -- behaves the same as running it
					// just before a `while` for every purpose that matters here (nothing else
					// shares this loop's own block-scoping).
					if (s.init) {
						if (s.init.type === 'var_decl')
							recurse(s.init, 'statement');
						else
							recurse(s.init, 'expression');
					}
					// 2. Desugar to `while (test) { body; update; }`, folding `update` into the
					// tail of the body's own NORMAL (non-continue) path -- reusing buildLoop's
					// existing while-shaped mu/theta machinery entirely as-is. `continue` needs its
					// own handling (see that case) since it would otherwise skip `update` the way a
					// real while-loop's continue does -- real for-loop semantics don't allow that.
					const test = s.test ?? Literal(true);
					const body = s.update ? JS.Block(s.body, JS.Expression(s.update)) : s.body;
					buildLoop(recurse, test, body, false, s.update);
					return false;
				}

				case 'switch': {
					// Lowered into an ordinary if-cascade -- each case is structurally its own binary
					// branch ("hit or matched" vs "not yet"), chained forward into the next case, using
					// walkBranch/mergeState/reconcileVariables directly (the same shared pieces 'if'
					// itself is built from, see their own comments) -- switch needs no graph machinery
					// of its own beyond this framing and the break_scope anchor below.
					//
					// Evaluate the discriminant exactly once, giving it a dedicated wrapper node so
					// every case test can read the SAME value (same reasoning as var_decl's own
					// dedicated-wrapper comment, a few cases up).
					recurse(s.discriminant, 'expression');
					const discValue = getExprNode(s.discriminant);
					const discNode	= makeNode('var');
					connectValue(discValue, 0, discNode, 0);
					discNode.declKind = 'let';
					const suffix	= discNode.id;
					const discName	= `__disc_${suffix}`;
					discNode.value	= discName;
					// rebindVar (not a bare scope.create) matters here: it's what threads discNode
					// into the state chain via threadMutation. Without it, discNode is never
					// scheduled anywhere Output's own reconstruction reaches -- `let __disc = ...;`
					// silently never gets printed even though every case test still reads its name.
					rebindVar(discName, discNode, true);

					// Each case's own test is evaluated EXACTLY ONCE, in source order (real switch
					// semantics: a test with a side effect, e.g. `case f():`, runs once each, in
					// order -- reusing the same expression object a second time, to compute
					// `default`'s condition below, would re-walk and re-run it). Captured into its
					// own named boolean so nothing else ever needs to read the comparison twice.
					// `c.test` itself gets walked here too, as the comparison's RHS -- its resolved VSDG
					// node (captured alongside matchName, not re-walked) is what the printed case label
					// reads later, instead of the raw source expression: reusing this walk is what keeps
					// evaluation to exactly once while still letting the label reflect VSDG's own
					// resolution (a renamed identifier, an inlined value, correct effect ordering, ...).
					const caseTestInfo = s.cases.map((c, i) => {
						if (!c.test)
							return { matchName: undefined, testNodeId: undefined };
						const matchName = `__match${i}_${suffix}`;
						recurse(JS.VarDecl('let', JS.Var(matchName,
							{ type: 'binary', operator: '===', left: Identifier(discName), right: c.test } as Expr
						)));
						return { matchName, testNodeId: getExprNode(c.test).id };
					});
					const matchNames = caseTestInfo.map(t => t.matchName);

					// A hidden "have we entered some case yet" flag, reassigned exactly like an
					// ordinary variable -- rides the SAME per-variable gamma/mu/theta machinery as
					// any real local, so fallthrough across case boundaries just works via ordinary
					// reassignment-merging, with no new graph machinery needed for it.
					const hitName = `__hit_${suffix}`;
					recurse(JS.VarDecl('let', JS.Var(hitName, Literal(false))));

					// `default` matches iff none of the OTHER cases' tests matched -- independent of
					// its own position (real switch semantics: default only wins when nothing else
					// does, wherever it's written), so this is built once from every real case's
					// match flag, not just "the ones textually before it".
					const realMatches = matchNames.filter((n): n is string => n !== undefined);
					const negateOr = (names: string[]): Expr => names.length === 0
						? Literal(true)
						: {
							type: 'unary', operator: '!',
							operand: names.map((n): Expr => Identifier(n)).reduce((a, b) => ({ type: 'binary', operator: '||', left: a, right: b } as Expr)),
						} as Expr;

					// Each case becomes `if (hit || <own condition>) { hit = true; ...body... }`:
					// once true, `hit` makes every later case's own test irrelevant, giving
					// fallthrough for free (a case with no `break` just runs straight into the
					// next one, exactly as real switch fallthrough does). Every case is structurally
					// its own binary branch -- "hit or matched" vs "not yet, keep looking" -- so this
					// chains walkBranch/mergeState/reconcileVariables directly, once per case, instead
					// of synthesizing a whole `JS.If` statement per case just to recurse back into it:
					// exactly the same shape 'if' itself now uses, just looped instead of called once.

					// A `break_scope`: a scope that `break` exits, with none of a loop's iteration
					// machinery (no mu/theta, no re-entry point) -- a switch shares a loop's "break
					// exits me" property but not its "continue re-enters me" one, so it gets the
					// minimal anchor for the former without inheriting machinery for the latter it
					// doesn't need. This also fixes a real bug an earlier `while (true) { ...; break; }`
					// wrapping had: since that wrapper genuinely was a loop, a `continue` inside a case
					// (meant to skip PAST the switch to whichever real loop encloses it, per real JS
					// semantics) got wrongly caught by the wrapper itself instead -- an infinite loop
					// whenever the switch's own discriminant test stayed constant across iterations.
					// An empty switch (`switch (x) {}`) has no case body that could ever contain a
					// break, so it needs no scope at all -- just falls straight through (the
					// discriminant's own evaluation, already threaded above, is its only effect).
					// Skipping this also avoids a real degenerate case: with no cases to walk, `end`
					// would still be `breakScope` itself when connecting its own tail, wiring the
					// anchor to itself.
					if (s.cases.length > 0) {
						// The anchor is created AFTER walking the cases, not before -- exactly like
						// a gamma's own predecessor/tail split. Creating it first (and setting `end`
						// to it before walking) would make the first case's own `parent.end` BE the
						// anchor itself, so Output's own emitChain (walking backward from a case's
						// own tail to its boundary) would stop at the anchor's own, still-being-built
						// node on its very first step, before ever reaching the real predecessor.
						//
						// A dedicated start marker sits BETWEEN the real predecessor and the cases'
						// own walk, rather than letting them share `predecessor` directly: the first
						// case, if it needs a real state-gamma of its own (e.g. it contains a break),
						// would otherwise have that gamma share the EXACT SAME predecessor node as
						// break_scope itself -- giving each of them their own, distinct anchor node
						// keeps every switchCaseInfos boundary/tail pair unambiguous.
						const predecessor = end;
						const startMarker = makeNode('effect', 'BREAK_SCOPE_START');
						connectEnd(startMarker);
						exited		= false;
						brokeOut	= false;

						// Recorded per case for Output's own emitControlNode to reconstruct a REAL
						// `switch`/`case` -- see switchCases's own comment on Node for why
						// `boundaryId` is captured AFTER `hit = true;`, not at the case's own
						// `parent.end`, and why testNodeId isn't just `c.test` printed directly.
						const switchCaseInfos: { testNodeId?: NodeId; boundaryId: NodeId; tailId: NodeId }[] = [];

						for (const [i, c] of s.cases.entries()) {
							const testExpr = {
								type: 'binary', operator: '||',
								left: Identifier(hitName),
								right: matchNames[i] ? Identifier(matchNames[i]!) : negateOr(realMatches),
							} as Expr;
							recurse(testExpr, 'expression');
							const testNode	= getExprNode(testExpr);
							const parent	= getState();
							let bodyBoundary: Node | undefined;
							const trueState = walkBranch(parent, () => {
								// A real 'binary' '=' node (not a bare rebind to a fresh literal), so
								// it's eligible for the same isInlinableSlot elision as any ordinary
								// reassignment -- matches what the original synthetic `hit = true;`
								// AST fragment would have built by going through the same expression hook.
								// switchInternal (see Node's own field comment) is what keeps THIS
								// specific reassignment always resolving by name, regardless of
								// forcedPrint/needsTemp -- its own mutation is structurally never
								// printed (see switchCases's own boundaryId comment), so anything else
								// must be safe to fold in exactly the same way.
								recurse({ type: 'binary', operator: '=', left: Identifier(hitName), right: Literal(true) } as Expr, 'expression');
								scope.get(hitName)!.switchInternal = true;
								bodyBoundary = end;
								for (const stmt of c.consequent)
									recurse(stmt, 'statement');
							});
							const falseState = walkBranch(parent, () => {});
							// The state gamma mergeState MAY build here (if this case has a real effect
							// or exits) belongs entirely to switch's own internal if-cascade, which
							// switchCases's own print-time reconstruction bypasses completely -- its
							// condition edge (unlike an ordinary if's gamma, which genuinely needs it to
							// print `if (cond)`) is never actually read. Tagged switchInternal so
							// isVestigialEdge can exclude it (see its own comment) the same way it
							// already excludes an ordinary gamma's structural tail ports.
							const stateGamma = mergeState(parent, testNode, trueState, falseState);
							if (stateGamma)
								stateGamma.switchInternal = true;
							reconcileVariables(parent, testNode, trueState, falseState);
							switchCaseInfos.push({ testNodeId: caseTestInfo[i].testNodeId, boundaryId: bodyBoundary!.id, tailId: trueState.end.id });
						}
						const tail = end;

						const breakScope = makeNode('break_scope');
						connectValue(predecessor, 0, breakScope, 0);
						// Port 1 = the scope's own tail (mirrors a gamma's true/false-tail ports): the
						// node Output's own emitChain walks backward from to find the wrapped content.
						connectValue(tail, 0, breakScope, 1);
						breakScope.switchDiscriminantId = discNode.id;
						breakScope.switchCases = switchCaseInfos;
						end			= breakScope;
						exited		= false;
						brokeOut	= false;
					}
					return false;
				}
				case 'try': {
					// A bare `try { } finally { }` (no catch) isn't attempted here -- there's no
					// value to merge in that shape (nothing diverges, since only one path exists),
					// which is a genuinely different, simpler case this doesn't cover yet.
					if (!s.handlerBody) {
						console.log(`not handling try without catch`);
						return process(s);
					}
					const parent = getState();

					// Each branch gets its own dedicated start marker (a plain, non-"preferred"
					// effect) between the shared predecessor and its own walk -- same reasoning as
					// break_scope's own start marker: without one, if a branch's OWN first
					// statement also needed a real gamma/mu/break_scope/except of its own, it would
					// share the EXACT SAME predecessor node as `except` itself; giving each of them
					// their own, distinct anchor node keeps their spans unambiguous.
					const startMarker = (pred: Node, tag: string) => {
						const marker = makeNode('effect', tag);
						connectValue(pred, 0, marker, 0);
						return marker;
					};

					// Each branch gets TWO nested scopes, not one: an outer "branch" scope (matching
					// if/else's own, read directly by the reconciliation loop below) and an inner
					// "block" scope that gets closeAndFlush()'d before that read happens. Without
					// the inner one, a `let`/const declared directly in `s.block`/`s.handlerBody`
					// (a plain statement array here, unlike if's consequent/alternate, which are
					// always a real 'block' AST node with this same filtering already built in)
					// would leak straight into the branch scope's own bindings -- closeAndFlush is
					// what strips OUT anything `local` (declared via `.create`, not `.set`) before
					// it can ever reach the reconciliation loop, same as it already does for 'if'.
					// The catch parameter needs the exact same treatment, so it's bound on the
					// INNER scope too.
					setState(new Scope(parent.scope), startMarker(parent.end, 'TRY_START'));

					scope = new Scope(scope);
					for (const stmt of s.block)
						recurse(stmt, 'statement');
					scope = scope.closeAndFlush()!;
					const tryState		= getState();

					setState(new Scope(parent.scope), startMarker(parent.end, 'CATCH_START'));
					scope = new Scope(scope);
					// catchParamName is what actually prints as `catch (<here>) {...}` -- for a
					// destructured param, that's the hidden temp, with the real pattern desugared
					// into flat var_decls at the top of the handler body (same split params/var_decl
					// destructuring already use); the temp is just as opaque/externally-provided as
					// an ordinary named catch param, so it gets the same no-input-edge 'var' node.
					let catchParamName: string | undefined;
					if (typeof s.handlerParam === 'string') {
						catchParamName = s.handlerParam;
						scope.create(catchParamName, makeNode('var', catchParamName));
					} else if (s.handlerParam) {
						catchParamName = `__destructure${nextId++}`;
						scope.create(catchParamName, makeNode('var', catchParamName));
						for (const stmt of patternBindings('let', s.handlerParam, Identifier(catchParamName)))
							recurse(stmt, 'statement');
					}
					for (const stmt of s.handlerBody)
						recurse(stmt, 'statement');
					scope = scope.closeAndFlush()!;
					const catchState	= getState();

					// Unlike an `if`'s gamma, this is never skipped even when neither branch has a
					// real effect: `try`/`catch` is observable syntax in its own right (unlike
					// `if`/`else`, which really can dissolve into a pure ternary with no structural
					// trace left), so it always needs a real anchor to reconstruct from.
					const exc = makeNode('except');
					if (catchParamName !== undefined)
						exc.catchParam = catchParamName;
					connectValue(parent.end, 0, exc, 0);
					connectValue(tryState.end, 0, exc, 1);
					connectValue(catchState.end, 0, exc, 2);
					end = exc;

					// Per-variable merges -- mirrors 'if', except neither branch's boundName is ever
					// cleared: there's no printable condition to build a ternary from the way a
					// gamma's merge can, so each branch keeps (and force-prints) its own `x = ...;`
					// reassignment under its own name instead, and the merge just needs to connect
					// BOTH as real dependencies so GCM schedules anything reading `x` afterward no
					// earlier than whichever branch runs (see forcedPrint's own comment).
					scope = parent.scope;
					const diverged = new Set([...tryState.scope.bindings.keys(), ...catchState.scope.bindings.keys()]);
					for (const name of diverged) {
						const tryVal	= tryState.scope.get(name)!;
						const catchVal	= catchState.scope.get(name)!;
						if (tryVal !== catchVal) {
							if (tryVal.boundName === name)
								tryVal.forcedPrint = true;
							if (catchVal.boundName === name)
								catchVal.forcedPrint = true;

							const namedExc = makeNode('except', name);
							connectValue(tryVal, 0, namedExc, 0);
							connectValue(catchVal, 0, namedExc, 1);
							scope.set(name, namedExc);
						}
					}

					// `finally` runs after the merge on the normal (non-exited) path -- reusing the
					// same "walk it like ordinary code, tag its own tail" shape as everything else
					// here, NOT trying to model "runs on every exit path" at the graph level at all:
					// since this reconstructs a REAL `finally` clause (see Output's own emitControlNode),
					// real JS's own semantics already guarantee that on their own, for every exit (including
					// a return/break/continue escaping try/catch), with no extra machinery needed.
					let finallyExited = false;
					let finallyBrokeOut = false;
					if (s.finalizer) {
						end = startMarker(exc, 'FINALLY_START');
						exited = false;
						brokeOut = false;
						// Same reasoning as try/catch's own inner scope: a `let`/const declared
						// directly in `s.finalizer` shouldn't leak into the outer scope, but an
						// ordinary reassignment of an outer variable should still propagate (code
						// after the whole try/catch/finally needs to see it) -- closeAndFlush is
						// what gives exactly that split.
						scope = new Scope(scope);
						for (const stmt of s.finalizer)
							recurse(stmt, 'statement');
						scope = scope.closeAndFlush()!;
						finallyExited = exited;
						finallyBrokeOut = brokeOut;
						// Port 3 = finally's own tail (mirrors a gamma's true/false-tail ports): the
						// node Output's own emitChain walks backward from to find the wrapped content.
						connectValue(end, 0, exc, 3);
						end = exc;
					}
					// A return/throw/break/continue inside `finally` itself overrides whatever
					// try/catch was doing, so the WHOLE construct only falls through when finally
					// (if present) does too -- same reasoning as `tryState.exited && catchState.exited`
					// alone would give if there were no finally to consider. brokeOut mirrors it, for
					// whatever ENCLOSING switch/loop reconciliation might read this try/catch's own
					// state as ITS OWN trueState/falseState -- see reconcileVariables's own comment.
					exited = finallyExited || (tryState.exited && catchState.exited);
					brokeOut = s.finalizer
						? finallyBrokeOut
						: (tryState.exited && catchState.exited && tryState.brokeOut && catchState.brokeOut);
					return false;
				}
				case 'expression':
					break;

				case 'export_decl': {
					// `export class Foo {...}`/`export function f() {...}`/`export const x = 1;` --
					// previously entirely unhandled, falling to the generic `default:` case below,
					// whose own `process(s)` ALSO independently walks `s.declaration` as part of its
					// generic descent (see walker.ts's `case 'export_decl': return
					// walkStatement(stmt.declaration);`), on top of `default:`'s own passthru node
					// embedding the whole (declaration-inclusive) `s` verbatim -- building the
					// declaration TWICE (once from that independent recursion, once from the outer
					// verbatim reprint), hence the literal duplicate class this fixes. Recursing here
					// runs the declaration's own dedicated handler EXACTLY once; `exported` (stamped on
					// whatever node it left behind) is read back wherever THAT node's own type gets
					// printed, to wrap it in `export `.
					recurse(s.declaration, 'statement');
					if (s.declaration.type === 'var_decl') {
						// `end` here is a MUTATION_MARKER (threadMutation's own bookkeeping wrapper
						// around the LAST declarator's rebindVar, see its own comment) -- never printed
						// itself, and wrong besides for `export const a = 1, b = 2;` (every declarator
						// needs the flag, not just the last). Each declared name's REAL node is looked
						// up directly from scope instead, where rebindVar left it.
						for (const v of s.declaration.declarations)
							if (typeof v.name === 'string')
								scope.get(v.name)!.exported = 'named';
					} else {
						end.exported = 'named';
					}
					return false;
				}

				case 'import': {
					// Previously fell to the generic `default:` case below: verbatim passthru, correctly
					// ordered in the state chain, but its bound names (namespace/default/named specifiers)
					// were never bound into scope at all -- any later read of e.g. `bin` in `import * as
					// bin from '...'` found nothing there and silently fell back to getExprNode's
					// undeclared-external-name path (the same one `console`/`Math` use), a bare 'var' node
					// sharing only the string "bin", with zero real inputs and no connection whatsoever to
					// this import statement. scheduleEarly had nothing to floor it against but block_entry,
					// so anything derived from it (`bin.text`, say) could get hoisted above the import that
					// actually provides it. Fixed by giving each bound name its own declKind-less, boundName-
					// less 'var' node (the same shape externalNodes already uses -- see its own comment --
					// so it never gets a declaration statement of its own; the import statement's own
					// passthru node is what actually declares it, verbatim) with a threadMutation scheduling
					// anchor (the same port-2 convention rebindVar already uses for var_decl/reassignment)
					// chained right after the import's own passthru node, so GCM can never place a read of
					// it earlier than the import that provides it. A type-only import (or a type-only named
					// specifier within an otherwise-real one) is erased entirely at runtime and binds no
					// real value, so it's skipped -- nothing should ever read it as a value in the first
					// place.
					process(s);
					const node = makeNode('passthru', s);
					connectEnd(node);
					if (!s.typeOnly) {
						const bindImport = (name: string) => {
							const varNode = makeNode('var', name);
							threadMutation(varNode);
							scope.create(name, varNode);
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
					// `export default class Foo {...}`/`export default function f() {...}` -- same
					// double-processing risk and same fix as export_decl above. A plain-expression
					// default (`export default 1 + 1;`) has no declared name to anchor a node under,
					// so it stays on the generic passthru fallback below -- same partial-fidelity
					// tradeoff 'class'/'passthru' already accept elsewhere for anything without a
					// dedicated reconstruction. `export {a, b};`/`export * from '...'` (no `default`
					// at all) reference only ALREADY-declared bindings by name, so passthru is exactly
					// right for those too: nothing there needs VSDG resolution in the first place.
					if (s.default !== undefined && (isJsStatement(s.default) || isTsDeclaration(s.default))) {
						recurse(s.default, 'statement');
						end.exported = 'default';
						return false;
					}
					process(s);
					connectEnd(makeNode('passthru', s));
					return false;
				}

				case 'class_decl': {
					// Previously fell to the generic `default:` case below (a bare 'passthru' node),
					// same as any other codeless-from-VSDG's-perspective declaration (interface,
					// type alias, ...) -- but a class_decl isn't codeless, and needing to check
					// `typeof node.value === 'object' && node.value.type === 'class_decl'` at print
					// time to tell "this passthru is actually a resolved class" apart from "this one
					// really is verbatim" is exactly the fragile, shared-tag-disambiguated-by-value
					// pattern gamma/gammaValue, mu/muValue, and theta/thetaValue all got split out of
					// this session, for the same reason: it's a real, avoidable source of bugs (see
					// gammaValue's own history). A dedicated type tag makes "this always needs
					// rebuildClass, unconditionally" a property of the node itself. Anchored as its
					// own statement (not an 'effect', which 'class' the expression uses instead) since
					// a class_decl produces no value of its own the way a class expression does. See
					// buildClass's own comment for what's resolved vs. still verbatim.
					const node = makeNode('class_decl', s);
					node.classInfo = buildClass(recurse, node, s);
					connectEnd(node);
					return false;
				}

				default:	{
					// like function_decl above, for the same reason (an unreferenced declaration is otherwise an unanchored island nothing ever schedules or visits).
					process(s);
					const node = makeNode('passthru', s);
					connectEnd(node);
					return false;
				}
			}
			return process(s);
		},
		// on EXPRESSION
		(s, process, recurse) => {
			// Every case below that needs its children processed first calls `process(s)` itself, then
			// returns `false` immediately -- never `break` -- so control never reaches a second, implicit
			// `process(s)` call. Falling through to that (the previous behavior) walked children TWICE,
			// which for a nested call like `f(g())` created two separate effect nodes for `g()` (i.e.
			// `g` got compiled to run twice).
			switch (s.type) {
				case 'literal':
					expnodes.set(s, makeNode('literal', s.value));
					return false;

				case 'identifier':
					return false;

				case 'super':
				case 'this': {
					// Unlike 'identifier', which getExprNode resolves via a dedicated scope lookup that
					// bypasses expnodes entirely, `this`/`super` have no such lookup -- they need a real
					// node registered here, or any consumer (`this.x`, `f(this)`, ...) throws "missing
					// node" trying to look one up that was never created.
					const node = makeNode(s.type);
					// See Node's own scopeAnchorId comment -- without this, a this-derived value that
					// GCM forces to materialize (its own scheduleEarly has nothing to floor it against,
					// unlike a param's real function_decl edge) defaults to block_entry, escaping the
					// function/class it belongs to entirely.
					node.scopeAnchorId = currentFunctionEntry?.id;
					expnodes.set(s, node);
					return false;
				}

				case 'unary': {
					// The parser gives `await x` the exact same prefix-unary AST shape as `-x`/`typeof x`
					// (see js-parser.ts's own unaryOps list) -- but unlike those, it's not pure: it's
					// structurally identical to 'yield' (an operand is evaluated, then the current
					// effect sequence must include this exact point, never reordered/dropped/duplicated
					// relative to other effects around it -- the actual suspend/resume machinery is
					// downstream, towasm.ts's own job, same division of labor 'yield' already documents;
					// nothing about it needs modeling here). Treating it as an ordinary value node (the
					// unconditional path below) would let it be silently reordered or inlined away
					// exactly like a pure computation would.
					if (s.operator === 'await') {
						process(s);
						const node = makeExprNode(s, 'effect');
						connectEnd(node);
						connectValue(getExprNode(s.operand), 0, node, 1);
						return false;
					}
					process(s);
					const node = makeExprNode(s as Expr);
					connectValue(getExprNode(s.operand), 0, node, 0);
					if (s.operator === '++' || s.operator === '--') {
						if (s.operand.type === 'identifier')
							rebindVar(s.operand.name, node);
					}
					return false;
				}
				case 'unary_post': {
					// The parser gives the non-null assertion (`expr!`) the exact same `unary_post` AST
					// shape as a real, mutating postfix `++`/`--` (see ts-parser.ts's own `Rule([member,
					// '!'], $ => UnaryPost('!', $[0]))`) -- but `!` has NO runtime effect at all, purely a
					// compile-time type assertion, exactly like `as`/`satisfies`/`instantiation` just
					// above: alias straight through, no new node, no old-value snapshot, no rebind. Found
					// on real code (binary-libs/src/pe.ts): `dir.FunctionTable!` was forced through the
					// SAME "always materialize, never lazily recompute" rule real `i++` needs (see
					// needsTemp's own 'unary_post_old' case), producing a needless `var t8 = ...;` for a
					// value with exactly one real consumer.
					if (s.operator === '!') {
						process(s);
						expnodes.set(s, getExprNode(s.operand));
						return false;
					}
					// Unlike prefix, `i++`/`i--` evaluates to the OLD value. Can't alias the expression
					// directly to the operand's own node (the same aliasing hazard var_decl's "dedicated
					// wrapper" comment warns about, just one level removed): that node stays reachable BY
					// NAME after the rebind below, so anything resolving it later would silently pick up
					// the NEW value instead of the one that was actually here at this point. A dedicated
					// snapshot node, threaded into the state chain right here -- before the rebind -- pins
					// both its identity and its schedule position to this exact moment (see needsTemp's
					// matching 'unary_post_old' case for why it's always forced to materialize, never
					// lazily recomputed at some later, possibly-past-the-mutation, consumer).
					process(s);
					const operandNode = getExprNode(s.operand);
					const oldNode = makeNode('unary_post_old', s);
					connectValue(operandNode, 0, oldNode, 0);
					threadMutation(oldNode);
					expnodes.set(s, oldNode);
					if (s.operand.type === 'identifier') {
						const node = makeNode('unary_post', s);
						connectValue(operandNode, 0, node, 0);
						rebindVar(s.operand.name, node);
					}
					return false;
				}
				case 'binary': {
					process(s);
					const node = makeExprNode(s as Expr);
					connectValue(getExprNode(s.left), 0, node, 0);
					connectValue(getExprNode(s.right), 0, node, 1);
					if (ASSIGN_OPS.has(s.operator)) {
						if (s.left.type === 'identifier') {
							// A reassignment of a variable CAPTURED from an enclosing function (not
							// declared anywhere within the current one -- see isLocalToCurrentFunction)
							// is, like a property assignment, an effect that escapes this function: its
							// only real "consumer" may be a caller that hasn't run yet, so a same-region
							// consumer-count check (needsTemp/isInlinableSlot) can't safely decide it's
							// dead or inlinable. forcedPrint makes sure it always prints under its own
							// name; scheduleLate's own region-boundary check (see regionRootOf) is what
							// keeps it correctly scheduled INSIDE this function rather than dragged out
							// to wherever a later, outer read of the same name happens to live.
							if (!scope.isLocalToCurrentFunction(s.left.name))
								node.forcedPrint = true;
							rebindVar(s.left.name, node);
						} else {
							// A property/index assignment (`obj.prop = x`/`arr[i] = x`) mutates something
							// OUTSIDE this pass's own scope tracking -- always an observable effect,
							// unlike reassigning a local variable (whose entire observable effect IS the
							// scope rebind rebindVar does above). threadMutation (not rebindVar -- there's
							// no name to bind here) anchors it into the state chain the same way a
							// var_decl's own declaration is; forcedPrint (see emitLocalStatements's own
							// default case) makes sure it always prints regardless of consumer count --
							// unlike a bound variable, nothing ever reads it back through scope, so
							// needsTemp alone would see zero consumers and silently drop it.
							node.forcedPrint = true;
							threadMutation(node);
						}
					}
					return false;
				}

				case 'call': {
					// 1. Thread the State Edge to preserve sequence
					process(s);
					// TEMPORARY placeholder for real purity analysis (not implemented yet): a callee
					// name starting with "pure" (e.g. `pureFoo()`) is treated as pure for testing, so
					// both code paths can be exercised from the same source snippet -- has nothing to
					// do with actual purity and should be replaced once real analysis exists.
					const pure = s.callee.type === 'identifier' && s.callee.name.startsWith('pure');
					const node = pure ? makeExprNode(s) : makeExprNode(s, 'effect');
					if (!pure)
						connectEnd(node); // Slot 0 = Input State

					// 2. Thread Value Edges for the function arguments
					s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));

					// The callee itself is still printed verbatim, unresolved (buildEffectExpr spreads
					// `value` through unchanged, only overriding `arguments`) -- a callee can be an
					// arbitrary expression (`(a || b)()`, `obj.method()`, ...), and there's no call site
					// here that would benefit from resolving it as a VALUE. But a bare identifier
					// callee still needs a REAL graph edge, purely so hasRealConsumer sees it: without
					// one, a variable whose only remaining read is `f()` (its declared value never used
					// any other way) looks entirely unread, and gets dropped as dead -- `const g =
					// makeThing(); g();` printed `makeThing(); let g; g();` (already broken before ANY
					// of this call even runs, since `g` was never assigned). The extra port (right after
					// the arguments) is never read back for VALUE resolution, only for this counting.
					connectValue(getExprNode(s.callee), 0, node, s.arguments.length + 1);
					return false;
				}

				case 'new': {
					// Always treated as an effect, like an impure call -- a constructor can run
					// arbitrary code, so there's no equivalent of `call`'s "pureFoo" opt-in here.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectEnd(node);
					s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));
					// See 'call' above for why the callee still needs a real edge despite never being
					// resolved as a value.
					connectValue(getExprNode(s.callee), 0, node, s.arguments.length + 1);
					return false;
				}

				case 'yield': {
					// Treated as an effect, exactly like an impure call -- a generator's resume value is
					// as opaque to this pass as a call's return value, and the ONLY thing that actually
					// matters here is that a yield never gets reordered relative to other effects around
					// it (state-chain threading already guarantees that). The actual suspend/resume
					// machinery is towasm.ts's own job, downstream of this pass reconstructing the
					// source in the right order -- nothing about generator state needs modeling here.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectEnd(node);
					if (s.operand)
						connectValue(getExprNode(s.operand), 0, node, 1);
					return false;
				}

				case 'tagged_template': {
					// `` tag`...${x}...` `` desugars to calling `tag` with a strings array plus each
					// interpolated expression -- effectful exactly like an ordinary impure call (`tag`
					// itself could be anything). The literal string parts of `quasi` are compile-time
					// data, carried through in node.value unchanged; only the interpolated `.exp`s (not
					// every part has one) need threading, same gap-tolerant index scheme 'array' uses
					// for elisions.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectEnd(node);
					s.quasi.forEach((part, index) => {
						if (part.exp)
							connectValue(getExprNode(part.exp), 0, node, index + 1);
					});
					return false;
				}

				case 'class': {
					// A class expression's own definition can run arbitrary code (a computed key, or
					// the heritage clause, can call out) -- always order-anchored, exactly like 'new'.
					// buildClass resolves heritage/keys/method-and-accessor-and-static-block bodies
					// through VSDG properly (see its own comment); an instance field's own initializer
					// is the one piece still left verbatim (see buildClassMember). Deliberately NOT
					// `process(s)` any more -- that walked the SAME pieces again, generically, on top
					// of buildClass's own targeted walk, double-processing them.
					const node = makeExprNode(s, 'effect');
					node.classInfo = buildClass(recurse, node, s);
					connectEnd(node);
					return false;
				}

				case 'jsx': {
					// A JSX element desugars to a factory call (`createElement(name, props, ...children)`
					// or similar) at runtime -- effectful for the same reason 'call' is. Attribute values
					// and children are real expressions that need threading (a spread attribute like
					// `{...props}` already has its own real 'spread' node, same as anywhere else); `name`
					// and each attribute's own key are compile-time metadata, carried through unchanged.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectEnd(node);
					let port = 1;
					s.attributes.forEach(attr => {
						if (attr.value)
							connectValue(getExprNode(attr.value), 0, node, port++);
					});
					s.children.forEach(child => connectValue(getExprNode(child), 0, node, port++));
					return false;
				}

				case 'arrow':
				case 'function': {
					if (!s.body)
						return false;
					// Type 'effect' (not buildFunctionBody's own default, 'function_decl') is what
					// makes isEffect/buildBlockTree recognize this as a printable value, resolved via
					// buildEffectExpr's own 'arrow'/'function' case (which prints `.value` verbatim --
					// so it must be set here; buildFunctionBody doesn't, since its other two callers
					// don't need the raw source at all). expnodes.set is what makeExprNode would
					// normally do for an expression -- needed so a LATER getExprNode(s) (e.g. this
					// arrow assigned to a variable, or returned) can find this node at all.
					const entry = buildFunctionBody(recurse, s, s.body);
					entry.type = 'effect';
					entry.value = s;
					expnodes.set(s, entry);
					// `entry`, not outer.end: buildFunctionBody's own restore always reverts to
					// outer.end (correct for a class member) -- but evaluating a function expression
					// (closure creation) is itself an observable, ordered event, same as a call, so
					// whatever reads it next (as a value) or comes after it (as a statement) must
					// chain from it instead.
					const state = getState();
					setState(state.scope, entry, state.exited, state.brokeOut);
					return false;
				}

				case 'member': {
					process(s);
					const node = makeNode('member', s.property);
					node.optional = s.optional;
					expnodes.set(s, node);
					connectValue(getExprNode(s.object), 0, node, 0);
					return false;
				}
				case 'index': {
					process(s);
					const node = makeExprNode(s);
					connectValue(getExprNode(s.object), 0, node, 0);
					connectValue(getExprNode(s.property), 0, node, 1);
					return false;
				}
				case 'conditional': {
					process(s);
					const node = makeExprNode(s);
					connectValue(getExprNode(s.test), 0, node, 0);
					connectValue(getExprNode(s.consequent), 0, node, 1);
					connectValue(getExprNode(s.alternate), 0, node, 2);
					return false;
				}
				case 'array': {
					process(s);
					const node = makeExprNode(s);
					s.elements.forEach((elem, index) => {
						if (elem)
							connectValue(getExprNode(elem), 0, node, index);
					});
					return false;
				}

				case 'object': {
					// A plain `key: value` field (static key) or a `...x` spread property is wired into
					// the graph, one value per port (index-matched against s.properties, same scheme as
					// 'array's element ports -- an unhandled property just leaves its port empty, and
					// buildExpr falls back to its original AST for that one property). Methods/get/set
					// and computed keys are real gaps, not silently mishandled: `process(s)` above still
					// walks them generically, so any calls nested inside still thread into the state
					// chain, but the reconstructed object literal won't reflect a GCM-moved value for them.
					const node = makeExprNode(s);
					s.properties.forEach((prop, index) => {
						if (prop.type === 'spread') {
							recurse(prop.operand);
							connectValue(getExprNode(prop.operand), 0, node, index);
							return;
						}
						if (prop.type !== 'field') {
							console.log(`not handling object property ${prop.type}`);
							return;
						}
						if (typeof prop.key !== 'string') {
							console.log(`not handling computed object key`);
							return;
						}
						recurse(prop.value, 'expression');
						connectValue(getExprNode(prop.value!), 0, node, index);
					});
					return false;
				}

				case 'spread': {
					// A bare spread node is only ever reached as an OPERAND of something else (a call
					// argument, an array/object element) -- never a standalone expression -- so it just
					// needs a real node to be addressable BY those consumers via getExprNode/connectValue,
					// carrying its own operand as a value input the same way 'unary' does.
					process(s);
					const node = makeExprNode(s);
					connectValue(getExprNode(s.operand), 0, node, 0);
					return false;
				}

				case 'as':
				case 'satisfies':
				case 'instantiation': {
					// Pure type-level annotation, no runtime effect -- alias straight through to
					// whatever the wrapped expression resolves to instead of allocating a new node.
					process(s);
					expnodes.set(s, getExprNode(s.expression));
					return false;
				}

				case 'sequence':
					// `(a, b, c)` evaluates all three in order (process(s) threads each's effects) but
					// its OWN value is only the last -- without registering that, anything reading the
					// sequence's own result (its sole use as a value, not just for effect) throws
					// "missing node" the same way an unhandled `this`/`super` did above.
					process(s);
					expnodes.set(s, getExprNode(s.expressions[s.expressions.length - 1]));
					return false;

//				default:
//					// Still walk children of an unhandled node type so anything useful nested inside
//					// (e.g. a call) is at least threaded into the graph, even though this node itself isn't.
//					process(s);
//					console.log(`not handling expr ${s.type}`);
//					return false;
			}
		},
		// on TYPE
		//(m, process) => process(m),
		// on CLASSMEMBER -- unreachable: 'class'/'class_decl' (see their own cases, above) walk their
		// own members directly via buildClass/buildClassMember now, instead of going through
		// process(s)'s generic per-member descent (which used to land here). Kept as a documented
		// no-op, not deleted outright, in case that ever changes.
		//() => false
	);
	programStart.programEndId = end.id;
	return graph;
}

// True for a node reached via the state chain's own port-2 "triggering rebind" convention (see
// BuildVSDG's threadMutation/rebindVar): a rebind (compound-assign/++/--, the same type check
// needsTemp itself uses at vsdg.ts:1965-1976 -- duplicated here since this asks "am I one of
// these" about the CONSUMER, where needsTemp asks it about the target of one of the consumer's
// edges), or a genuine local declaration (declKind set). Used by Output.needsDirectPlacement (the
// no-blocks fallback discovery).
function isOwnAnchorTarget(node: Node): boolean {
	if (node.type === 'unary_post')
		return true;
	if (node.type === 'unary')
		return ['++', '--'].includes((node.value as Expr & { type: 'unary' }).operator);
	if (node.type === 'binary')
		return ASSIGN_OPS.has((node.value as Expr & { type: 'binary' }).operator);
	return node.type === 'var' && node.declKind !== undefined;
}

// Desugars a destructuring BindingTarget into flat var_decls reading off valueExpr -- which MUST
// already be a stable, side-effect-free reference (a hidden temp name the caller bound the real
// initializer/param/catch-value to ONCE), never the raw initializer expression itself: an array/
// object pattern reads its own value MULTIPLE times (once per element/property), and re-evaluating
// an effectful initializer that many times would silently re-run it. Mirrors towasm.ts's own
// patternBindings (same overall shape, same `??`-based default simplification -- real default-value
// semantics use an `=== undefined` check, not `??`, which also triggers on `null`, but reusing `??`'s
// own single-evaluation-of-the-left codegen wholesale beats hand-rolling a second copy of that exact
// logic, and towasm.ts's own comment already documents this as a deliberate, accepted approximation)
// and the same two deliberate scope boundaries (no computed keys, no object rest -- a genuinely new
// "all fields except these" object type isn't modeled). Unlike towasm.ts's own version, `kind` is a
// real parameter, not hardcoded to 'const': a `let`-destructured binding that's later reassigned
// needs to stay reassignable, or the reconstructed source is invalid TypeScript.
function patternBindings(kind: JS.DeclarationKind, target: JS.BindingTarget, valueExpr: Expr): Statement[] {
	if (typeof target === 'string')
		return [JS.VarDecl<TS.Type>(kind, JS.Var<TS.Type>(target, valueExpr)) as Statement];

	if (target.type === 'array_pattern') {
		const stmts = target.elements.flatMap((el, i): Statement[] => {
			if (!el)
				return [];
			const elemExpr: Expr = JS.Index<TS.Type>(valueExpr, Literal(i));
			return patternBindings(kind, el.target, el.default ? { type: 'binary', operator: '??', left: elemExpr, right: el.default } as Expr : elemExpr);
		});
		if (target.rest)
			stmts.push(...patternBindings(kind, target.rest, JS.Call<TS.Type>(JS.Member<TS.Type>(valueExpr, 'slice'), [Literal(target.elements.length)])));
		return stmts;
	}

	if (target.rest) {
		console.log(`not handling destructured object rest`);
		return [];
	}
	return target.properties.flatMap((prop): Statement[] => {
		if (typeof prop.key !== 'string') {
			console.log(`not handling computed key in destructuring pattern`);
			return [];
		}
		const propExpr: Expr = JS.Member<TS.Type>(valueExpr, prop.key);
		return patternBindings(kind, prop.value, prop.default ? { type: 'binary', operator: '??', left: propExpr, right: prop.default } as Expr : propExpr);
	});
}

// True when `consumer` reads its own producer, at `port`, as a call/new's own CALLEE -- the same
// port convention BuildVSDG's own 'call'/'new' cases use (`s.arguments.length + 1`, right after
// every argument) and buildEffectExpr's own callee resolution relies on. Used by needsTemp to keep
// a member-access callee (`obj.method`) from ever materializing as a standalone temp: see its own
// comment for why that specifically breaks (the receiver `obj` gets lost).
function isCalleeEdge(consumer: Node, port: number): boolean {
	if (consumer.type !== 'effect' || typeof consumer.value !== 'object' || consumer.value === null)
		return false;
	const v = consumer.value as { type?: string; arguments?: unknown[] };
	return (v.type === 'call' || v.type === 'new') && port === (v.arguments?.length ?? 0) + 1;
}

// True when `consumer` reads its own producer, at `port`, in a way that requires the producer to
// be addressable BY NAME -- never resolved/recomputed inline, regardless of reuse count (unlike an
// ordinary value, which only needs a name once it has 2+ real readers). Two shapes: a mu/muValue's
// own initial-value (port 0) or feedback (port 1) port -- neither is ever actually READ via
// resolveNode (the mu itself is what's read everywhere it's used, never these edges), so a
// producer feeding either must be a real statement, or `i = i + 1;`/`i`'s own `= 0` silently
// vanish; or a rebind's own "old value" port (port 0 of a prefix/postfix unary or a compound
// assignment) -- inlining THAT away would silently turn a real mutation into a no-op recompute
// (`++0` printed in place of `++i`, `i` itself never advancing). Used by needsTemp to replace what
// used to be two separate, identically-shaped "return true unconditionally" checks.
function mustNameOwnValue(consumer: Node, port: number): boolean {
	if (consumer.type === 'mu' || consumer.type === 'muValue')
		return true;
	if (port !== 0)
		return false;
	if (consumer.type === 'unary_post')
		return true;
	if (consumer.type === 'unary')
		return ['++', '--'].includes((consumer.value as Expr & { type: 'unary' }).operator);
	return consumer.type === 'binary' && ASSIGN_OPS.has((consumer.value as Expr & { type: 'binary' }).operator);
}

// A real source-level name (`dir`, `sect`, `result`, ...) is only unique WITHIN its own function --
// two unrelated functions are free to each declare their own local by the same name. A flat
// `Set<string>` can't tell those apart: whichever one prints first claims the name, and every later,
// completely unrelated same-named local anywhere else in the file is then treated as "already
// declared," printed as a bare `name = ...;` reassignment to a name nothing ever actually declared --
// a guaranteed ReferenceError (ES modules are always strict mode). Found on real code
// (binary-libs/src/pe.ts): `dir`/`sect`/`result` each reused across unrelated functions, only the
// first occurrence in the file keeping its `const`. A stack of frames (one pushed per function body --
// see reconstructFunctionBody) fixes this while still correctly resolving a genuinely CAPTURED
// variable (declared in an enclosing function, read from a nested one): `has` walks the whole stack
// outward, `add` only ever writes to the innermost/current frame.
class ScopedNames {
	private stack: Set<string>[] = [new Set()];
	has(name: string): boolean {
		for (let i = this.stack.length - 1; i >= 0; i--)
			if (this.stack[i].has(name))
				return true;
		return false;
	}
	add(name: string): void {
		this.stack[this.stack.length - 1].add(name);
	}
	push(): void {
		this.stack.push(new Set());
	}
	pop(): void {
		this.stack.pop();
	}
}

export class Output {
	nodeVariableNames	= new Map<NodeId, string>();
	declaredNames		= new ScopedNames();
	tempVarCounter		= 0;

	// blockIds/blockControl/getLoopDepth are GCM's own output (applyGlobalCodeMotion) -- which
	// anchor node a given (possibly pure/floating) node was scheduled next to, the reverse lookup
	// from a block's id back to its anchor node, and how many loops enclose a given block. All
	// undefined for a caller that constructs an Output directly with no GCM pass behind it at all
	// (see the no-blocks work this session) -- resolveNode/buildExpr/emitLocalStatements don't
	// inherently need them, only buildProgram/emitChain/needsTemp's own loop-invariant check do,
	// and each degrades gracefully (no hoisting-driven materialization without a real schedule).
	constructor(
		public graph: Map<NodeId, Node>,
		private blockIds?: Map<NodeId, BlockId>,
		private blockControl?: Map<BlockId, NodeId>,
		private getLoopDepth?: (blockId?: BlockId) => number,
	) {}

	private blockNodesCache?: Map<BlockId, NodeId[]>;

	// The inverse of blockIds: which nodes GCM scheduled into a given block, grouped once on first
	// use (a block's node list has no identity of its own beyond "whichever nodes point at it").
	// A node with NO entry in blockIds (blockIds missing entirely, or -- shouldn't happen once real
	// GCM has run, since scheduleEarly visits every node -- an individual gap) is deliberately left
	// out of every block's list, not defaulted into 'block_entry': that used to silently dump the
	// WHOLE graph into block_entry's own list whenever blockIds was incomplete, since every missing
	// node collapsed onto the same fallback bucket. Left genuinely unplaced, such a node instead
	// falls through to resolveNode's own inline fallback wherever it's actually read.
	private blockNodes(blockId: BlockId): NodeId[] {
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

	private makeTempVar(id: NodeId) {
		const varName = `t${this.tempVarCounter++}`;
		this.nodeVariableNames.set(id, varName);
		return varName;
	}

	// True if `node`'s own value has at least one real reader, beyond whatever vestigial edges exist
	// (see isVestigialEdge). Zero means the value is genuinely dead -- e.g. every branch
	// unconditionally reassigns a variable before anything reads its declared value (a branch that
	// leaves it untouched, by contrast, DOES fall through to it as that branch's own merge value -- a
	// real, counted reader -- so this only fires when it's truly unused).
	private hasRealConsumer(node: Node): boolean {
		return (node.outputs[0] ?? []).some(e => !this.graph.get(e.nodeId)!.isVestigialEdge(e.port));
	}

	// A call node's return value is consumed as a VALUE if any of its output-port-0 consumers reads it
	// at a port other than the state-chain's own port 0 -- e.g. a `let y = f();` wrapper node reads
	// the call's result at ITS port 0 too, so the target's TYPE (not just the port) has to be checked.
	// True if `edge` is a gammaValue's own CONDITION port (0), where both branches are guaranteed to
	// resolve to the exact same name -- buildExpr's own "cond ? x : x" collapse (see its own
	// comment) -- so the condition is never actually READ once the merge collapses, despite being a
	// real graph edge. switchInternal is the reliable signal for this: it's exclusively stamped on
	// switch's own `hit` reassignment, whose merge always collapses this way (both trueVal and
	// falseVal resolve to the same slot name -- see resolveNode's own switchInternal check and the
	// var_decl-boundName-never-cleared rule in reconcileVariables). Counting it as a real consumer
	// would materialize a needless temp for a value whose only OTHER use already accounts for every
	// reference the printed output actually contains.
	private isCollapsingGammaValueCondition(edge: Edge): boolean {
		if (edge.port !== 0)
			return false;
		const target = this.graph.get(edge.nodeId)!;
		if (target.type !== 'gammaValue')
			return false;
		const trueVal = target.inputs[1] && this.graph.get(target.inputs[1].nodeId);
		const falseVal = target.inputs[2] && this.graph.get(target.inputs[2].nodeId);
		return !!(trueVal?.switchInternal || falseVal?.switchInternal);
	}

	private valueConsumers(node: Node): Edge[] {
		const CONTROL = new Set(['effect', 'gamma', 'gammaValue', 'mu', 'muValue', 'theta', 'thetaValue', 'break_scope', 'except', 'function_decl', 'passthru', 'class_decl']);
		return (node.outputs[0] ?? []).filter(e => {
			const target = this.graph.get(e.nodeId)!;
			if (CONTROL.has(target.type) && e.port === 0)
				return false;
			// A mu's feedback port (1) is exactly as much a pure state/scheduling edge as its
			// predecessor port (0) already excluded above -- never a real value read (see needsTemp's
			// own mu-consumer exception for the matching bug on the pure-value side of this). Left
			// counted, a call whose result happens to be the last thing before a loop's own feedback
			// wiring (e.g. a bare `g(i);` as a while loop's last statement) looks like it has a real
			// reader and gets a needless `var t0 = g(i);` instead of printing bare.
			if ((target.type === 'mu' || target.type === 'muValue') && e.port === 1)
				return false;
			if (target.isVestigialEdge(e.port))
				return false;
			if (this.isCollapsingGammaValueCondition(e))
				return false;
			// A var_decl target that will itself print bare (its own value has no further real
			// reader) never actually surfaces this value anywhere -- e.g. `let x = f();` where x is
			// dead becomes a standalone `f();` instead, so f()'s result isn't really "consumed" by x.
			if (target.type === 'var' && !this.hasRealConsumer(target))
				return false;
			return true;
		});
	}

	private hasValueConsumer(node: Node): boolean {
		return this.valueConsumers(node).length > 0;
	}

	// A pure value only needs its own `const tN = ...;` statement if it's genuinely REUSED (more than
	// one consumer). A single consumer can always resolve it lazily and inline it on demand instead
	// (see resolveNode's fallback to buildExpr) -- which block either one is scheduled to doesn't
	// matter: recomputing a pure expression is valid anywhere its own inputs are, so moving the text
	// of a literal/binary/etc. from wherever GCM placed it to its sole reader's position (earlier,
	// later, inside or outside a branch it's not itself conditional on) never changes its value. This
	// is exactly the common case for most intermediate arithmetic -- so `const t0 = a + b; let x = t0;`
	// becomes `let x = a + b;` -- and, past a block boundary, also what lets a branch-local pure
	// candidate (e.g. one side of an if/else merge) collapse straight into the merge's own ternary
	// instead of needing a temp of its own.
	// `allowReuse`, when true, exempts ONLY the final "read more than once, so give it a name for
	// readability" heuristic below -- never the structural checks above it (mu-consumer, a rebind's
	// own old-value operand, unary_post_old), which are about correctness, not readability, and must
	// always hold regardless of how cheap the value is to recompute. Used exclusively by
	// isInlinableVarDecl for a literal initializer: duplicating a literal at every read site costs
	// nothing, so multiple readers alone shouldn't force it to have a name -- but a literal feeding a
	// mu's own initial-value port still needs a REAL, MUTABLE variable for the loop to advance
	// (found the hard way: exempting the whole function via a blanket check first, instead of just
	// this one line, silently inlined a loop's own `i = 0;` away, breaking every loop-carried var).
	private needsTemp(node: Node, allowReuse = false): boolean {
		// A named theta's own condition edge is real in the GRAPH (GCM needs it) but never actually
		// read by codegen (see isVestigialEdge) -- e.g. a while loop's own test feeds not just the
		// state-theta's condition (the one real read) but ALSO every named theta's condition port,
		// one per loop-carried variable. Left uncounted, a loop with two loop-carried variables would
		// see the test as "reused" and give it a needless temp even though it's read exactly once.
		const consumers = (node.outputs[0] ?? []).filter(e => !this.graph.get(e.nodeId)!.isVestigialEdge(e.port) && !this.isCollapsingGammaValueCondition(e));
		// A member-access expression (`obj.method`) read as a call's own callee must NEVER
		// materialize as a standalone temp, regardless of what would otherwise force it below (a
		// loop-invariant hoist, a reuse count > 1): extracting it loses its receiver -- `var t0 =
		// this.update; t0(x);` calls with `this` undefined instead of the original object, a silent
		// runtime bug (found on real code, crc16.ts's own updateBuffer -- `this.update`, correctly
		// recognized as loop-invariant, got hoisted and called through the hoisted name). Checked
		// first and unconditionally, ahead of every rule below -- simpler and safer than trying to
		// preserve the receiver through a bound call or `.call(receiver, ...)` rewrite.
		if (node.type === 'member' && consumers.some(e => isCalleeEdge(this.graph.get(e.nodeId)!, e.port)))
			return false;
		// Two edge shapes -- a mu/muValue's own initial-value/feedback port, or a rebind's own "old
		// value" port -- both need the producer addressable BY NAME regardless of reuse count, never
		// resolved/recomputed inline the way an ordinary single-consumer value safely would (see
		// mustNameOwnValue's own comment for why each specifically breaks).
		if (consumers.some(e => mustNameOwnValue(this.graph.get(e.nodeId)!, e.port)))
			return true;
		// A postfix ++/--'s captured old-value snapshot (see 'unary_post' in BuildVSDG) exists solely
		// to freeze `i`'s value at this exact point, before the increment -- inlining it into a
		// consumer scheduled later (past the increment) would read the WRONG, already-mutated value.
		// Unlike an ordinary pure value, it's never safe to lazily recompute at the consumer's own
		// position, so any real consumer at all -- not just a second one -- forces it to materialize
		// here, at its own (correctly state-anchored) point instead.
		if (node.type === 'unary_post_old')
			return consumers.length > 0;
		// A value GCM scheduled SHALLOWER (fewer enclosing loops) than one of its own real
		// consumers is loop-invariant relative to that consumer -- e.g. `a * b` inside a loop
		// where neither operand is ever reassigned, hoisted by scheduleEarly to before the loop
		// (see its own comment on a muValue's trivial self-feedback). Inlining it at the
		// consumer's own position, the way an ordinary single-use value safely would, would
		// silently recompute it every iteration anyway, discarding the whole point of hoisting it
		// -- materializing it as its own statement, at its OWN (shallower) position, is the only
		// way the hoist is ever actually visible in the reconstructed source. Unconditional on
		// allowReuse/consumer count for the same reason the mu/rebind cases above are: this is a
		// structural necessity, not a "reused more than once" heuristic. No-ops gracefully without
		// a real GCM schedule (blockIds/getLoopDepth both undefined -- see the constructor's own
		// comment), since there's nothing to compare depths against.
		if (this.blockIds && this.getLoopDepth) {
			const ownDepth = this.getLoopDepth(this.blockIds.get(node.id));
			if (consumers.some(e => this.getLoopDepth!(this.blockIds!.get(e.nodeId)) > ownDepth))
				return true;
		}
		return !allowReuse && consumers.length > 1;
	}

	// A named slot (a plain reassignment or a gammaValue merge) whose value can be resolved
	// lazily by its sole consumer instead of needing its own printed statement -- same needsTemp
	// criteria as an anonymous temp, extended to cover 'gammaValue' as well as 'binary': a named
	// merge feeding ANOTHER named merge (e.g. an `else if` chain building nested per-variable
	// gammaValues) is exactly as inlinable as an ordinary reassignment feeding the very next
	// statement. Without this, a gammaValue with a single real consumer still unconditionally
	// resolves to `Identifier(name)` (see resolveNode's own shortcut) -- correct only when
	// something actually printed `name = ...;` for it, which isn't guaranteed: a purely-value
	// merge with no real effect in either branch has no state anchor forcing its own block to be
	// visited by Output's own emitChain at all, so it can end up scheduled into a block nothing
	// ever reaches, silently never printed while its consumer still reads its name as if it had
	// been. (The state gamma never reaches here at all -- slotName() only ever returns something
	// for gammaValue/named-except, so every caller already gates on that first.)
	private isInlinableSlot(node: Node): boolean {
		return (node.type === 'binary' || node.type === 'gammaValue') && !node.forcedPrint
			&& (node.neverMaterialize || !this.needsTemp(node));
	}

	private isEffect(node: Node): boolean {
		return node.type === 'effect' && !!node.value && typeof node.value === 'object'
			&& (node.value.type === 'call' || node.value.type === 'new' || node.value.type === 'yield'
				|| node.value.type === 'tagged_template' || node.value.type === 'class' || node.value.type === 'jsx'
				|| node.value.type === 'arrow' || node.value.type === 'function'
				// `await x` -- see BuildVSDG's own 'unary' case for why it's tagged 'effect' at all
				// despite sharing the plain 'unary' AST shape with pure operators like `-x`/`typeof x`.
				|| (node.value.type === 'unary' && (node.value as Expr & { type: 'unary' }).operator === 'await'));
	}

	// A destructured param prints as its own hidden temp name in the SIGNATURE too, not just the
	// body -- see destructuredParams' own comment for why: the body's own flat var_decls
	// (patternBindings) read the temp name, so the signature has to actually bind it under that
	// same name, or the printed function references a name nothing in its own signature declares.
	// A no-op (same object back) when this entry has no destructured params at all.
	private rebuildParams<T extends { params: JS.Param<any>[]; rest?: JS.Rest<any> }>(raw: T, entryNode: Node): T {
		if (!entryNode.destructuredParams)
			return raw;
		const rebuildKey = <P extends { key: JS.BindingTarget }>(p: P): P => {
			const tempName = entryNode.destructuredParams!.get(p.key);
			return tempName !== undefined ? { ...p, key: tempName } : p;
		};
		return { ...raw, params: raw.params.map(rebuildKey), rest: raw.rest && rebuildKey(raw.rest) };
	}

	// Splices VSDG's own resolution of a class's heritage/computed-keys/static-field-values/method-
	// and-accessor-and-static-block-and-instance-field-initializer bodies back into its otherwise-
	// verbatim member list (see buildClass's own comment for what's covered). `raw` is whatever
	// node.value already holds (a class expression, or a class_decl statement) -- loosely typed
	// since both shapes reach here, differing only in a few decl-specific fields (name, ambient,
	// ...) this never touches.
	private rebuildClass(raw: any, info: NonNullable<Node['classInfo']>): any {
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
						? { ...withKey, value: this.resolveFieldInitializer(this.graph.get(mi.entryNodeId)!) }
						: withKey;
				if (!mi.entryNodeId)
					return withKey;
				const entryNode = this.graph.get(mi.entryNodeId)!;
				return { ...this.rebuildParams(withKey, entryNode), body: this.reconstructFunctionBody(entryNode) };
			}),
		};
	}

	private buildEffectExpr(node: Node): Expr {
		const value = node.value as (Expr & {type: 'call' | 'new' | 'yield' | 'tagged_template' | 'class' | 'jsx' | 'arrow' | 'function' | 'unary'});
		if (value.type === 'arrow' || value.type === 'function')
			// GCM never moves anything INTO or OUT OF a function/arrow body (it's an isolated
			// sub-region, walked into its own entry/return-anchor pair -- see BuildVSDG's own case),
			// so node.value is still the original, untouched AST for the whole expression -- safe
			// to print verbatim, same partial-fidelity 'class' already accepted before its own
			// heritage/keys/method-bodies got real decomposition. Only entryNode's own SCHEDULING
			// (this node, as a whole) is real GCM's concern here -- not what's printed for it.
			return value;
		// `await x` -- see BuildVSDG's own 'unary' case and isEffect's own comment. Always has a
		// real operand (unlike 'yield', which can be bare), at the same port 1 convention.
		if (value.type === 'unary')
			return { ...value, operand: this.resolveOperand(node.id, 1) };
		if (value.type === 'yield')
			return { ...value, operand: value.operand ? this.resolveOperand(node.id, 1) : undefined };
		if (value.type === 'tagged_template')
			return { ...value, quasi: value.quasi.map((part, i) => part.exp ? { ...part, exp: this.resolveOperand(node.id, i + 1) } : part) };
		if (value.type === 'class')
			return node.classInfo ? this.rebuildClass(value, node.classInfo) : value;
		if (value.type === 'jsx') {
			let port = 1;
			return {
				...value,
				attributes: value.attributes.map(a => a.value ? { ...a, value: this.resolveOperand(node.id, port++) } : a),
				children: value.children.map(() => this.resolveOperand(node.id, port++)),
			};
		}
		// A call/new's own callee is normally left raw, unresolved (most shapes -- an identifier, a
		// member-of-identifier -- have nothing a graph resolution would change, and there's no need
		// for buildExpr's own coverage to be exhaustive over every possible callee shape). It's only
		// actually WRONG to leave verbatim when the callee itself embeds a real effect somewhere --
		// e.g. `new Point(3,4).sum()` (the member's own object is an effectful 'new') or a class
		// EXPRESSION callee's own heritage/keys/method-bodies (`new (class extends Base(FLAGS) {})()`)
		// -- since the graph ALSO threads that effect into the state chain as its own real node:
		// printing the raw source there duplicates its execution instead of reusing whatever the
		// graph already decided for it (inlined verbatim, or a materialized temp var). Found via the
		// SAME edge added purely for consumer-counting (see BuildVSDG's 'call'/'new' cases) -- reused
		// here instead of adding a second, redundant way to reach the callee's own node.
		const calleeEdge = node.inputs[value.arguments.length + 1];
		const calleeNode = calleeEdge && this.graph.get(calleeEdge.nodeId);
		// A PURE callee can still have been forced to materialize as its own named temp (e.g.
		// needsTemp's own loop-invariant check hoisting `this.method` -- a pure member read -- out
		// of a loop it's read inside): printing value.callee verbatim in that case duplicates the
		// raw source instead of referencing the temp GCM already decided to place elsewhere,
		// silently discarding the whole point of hoisting it. nodeVariableNames is checked
		// directly (rather than unconditionally calling resolveNode, which would also change output
		// for the common untouched case by routing every pure callee through buildExpr's own
		// reconstruction instead of the verbatim original source).
		const calleeTemp = calleeNode && this.nodeVariableNames.get(calleeNode.id);
		const callee = calleeTemp ? Identifier(calleeTemp)
			: calleeNode && !this.isPureSubgraph(calleeNode) ? this.resolveNode(calleeNode.id) : value.callee;
		return { ...value, callee, arguments: value.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
	}

	private buildExpr(node: Node): Expr {
		switch (node.type) {
			case 'literal':
				return Literal(node.value);

			case 'this':
			case 'super':
				return { type: node.type };

			case 'unary': {
				const un = node.value as (Expr & {type: 'unary'});
				return { ...un, operand: this.resolveOperand(node.id, 0) };
			}
			case 'unary_post': {
				const un = node.value as (Expr & {type: 'unary_post'});
				return { ...un, operand: this.resolveOperand(node.id, 0) };
			}
			case 'unary_post_old':
				return this.resolveOperand(node.id, 0);
			case 'array': {
				const arr = node.value as (Expr & {type: 'array'});
				return { ...arr, elements: arr.elements.map((elem, i) => elem ? this.resolveOperand(node.id, i) : elem) };
			}
			case 'object': {
				const obj = node.value as (Expr & {type: 'object'});
				return {
					...obj,
					properties: obj.properties.map((prop, i) =>
						prop.type === 'spread' ? { ...prop, operand: this.resolveOperand(node.id, i) }
						: prop.type === 'field' && typeof prop.key === 'string' ? { ...prop, value: this.resolveOperand(node.id, i) }
						: prop
					),
				};
			}
			case 'spread': {
				const sp = node.value as (Expr & {type: 'spread'});
				return { ...sp, operand: this.resolveOperand(node.id, 0) };
			}
			case 'binary': {
				const bin = node.value as (Expr & {type: 'binary'});
				if (ASSIGN_OPS.has(bin.operator)) {
					// Reaching here (rather than declareOrAssign) means this assignment node was
					// superseded by an if/else merge -- it's not being printed as its own `x = ...;`
					// statement, so what's needed is just the VALUE it would have produced: the right
					// operand for a plain `=`, or the computed result for a compound `+=`/`-=`/etc.
					// (Reconstructing the full `left = right` syntax here, as the generic case below
					// does, would wrongly re-print the assignment itself as part of a value expression.)
					const right = this.resolveOperand(node.id, 1);
					return bin.operator === '='
						? right
						: { type: 'binary', operator: bin.operator.slice(0, -1) as JS.binaryOps, left: this.resolveOperand(node.id, 0), right };
				}
				return { ...bin, left: this.resolveOperand(node.id, 0), right: this.resolveOperand(node.id, 1) };
			}
			case 'conditional':
			case 'gammaValue': {
				// A state gamma never reaches here at all -- reconstructed separately, by
				// emitControlNode's own 'gamma' case, as a real if/else.
				// A gammaValue is a pure per-variable value merge -- reconstruct it as a ternary,
				// which is exactly what it means.
				const consequent	= this.resolveOperand(node.id, 1);
				const alternate	= this.resolveOperand(node.id, 2);
				// Both operands can genuinely resolve to the SAME bare name -- e.g. a broken-out
				// merge (see reconcileVariables's own neverMaterialize case) where the live side is
				// still the original declaration, itself read elsewhere too many times to inline:
				// reading that name is correct EITHER way (the reassignment already happened, in
				// place, before the exit), so the condition is pure noise -- `cond ? x : x` always
				// just equals `x`.
				if (consequent.type === 'identifier' && alternate.type === 'identifier' && consequent.name === alternate.name)
					return consequent;
				return { type: 'conditional', test: this.resolveOperand(node.id, 0), consequent, alternate };
			}
			case 'member':
				return JS.Member(this.resolveOperand(node.id, 0), node.value as string, node.optional);
			case 'index': {
				const idx = node.value as (Expr & {type: 'index'});
				return { ...idx, object: this.resolveOperand(node.id, 0), property: this.resolveOperand(node.id, 1) };
			}
			case 'call': {
				// A PURE call (no observable side effects, so it never threads through the state
				// chain -- see the `pure` check in BuildVSDG's 'call' case) keeps its literal `.value.type`
				// ('call') as its OWN node type too, unlike an effectful one (always 'effect'). It's
				// otherwise just an ordinary value node: scheduled and (via needsTemp) materialized-or-
				// inlined the same as any pure expression.
				const call = node.value as (Expr & {type: 'call'});
				return { ...call, arguments: call.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
			}
			case 'effect':
				// Reaching here means an inlinable EFFECTFUL call (see emitLocalStatements' own
				// isEffect branch) was left unmaterialized and its sole consumer is now resolving it
				// directly. Other 'effect'
				// nodes (mutation markers, RETURN_ANCHOR, etc.) are never resolved as a value in the
				// first place, so isEffect's guard should always hold here.
				if (this.isEffect(node))
					return this.buildEffectExpr(node);
				console.log(`not handling value node ${node.type}`);
				return Literal(null);

			default:
				console.log(`not handling value node ${node.type}`);
				return Literal(null);
		}
	}

	// Emits either the FIRST declaration of a real source variable (`let x = ...;`, once) or a plain
	// reassignment of it (`x = ...;`, every time after) -- gamma merges and ++/--/= reassignments never
	// carry a declKind, so they always take the reassignment form; only a var_decl's own node does.
	private declareOrAssign(name: string, node: Node, expr: Expr): Statement {
		if (node.declKind && !this.declaredNames.has(name)) {
			this.declaredNames.add(name);
			return JS.VarDecl(node.declKind, JS.Var(name, expr, node.typeAnnotation)) as Statement;
		}
		this.declaredNames.add(name);
		return JS.Expression({ type: 'binary', operator: '=', left: Identifier(name), right: expr } as Expr) as Statement;
	}

	// A local declaration's initializer needs no printed value when nothing genuinely needs it under
	// x's own name at the declaration site: either it's truly dead (every branch unconditionally
	// reassigns x before any real read -- needsTemp reads 0 real consumers the same way it would for
	// an unused temp) or its one real reader is a single consumer that can just recompute the (pure)
	// initializer inline instead, same as any other pure value. Only safe when the initializer is
	// PURE -- an effectful one (`let x = f();`) with a real reader must still run at its declared
	// position, so it stays combined with the declaration there. A DEAD effectful initializer is
	// handled separately, in emitNamedSlot: the call
	// still needs to run, just not as x's value (see hasRealConsumer there). capturedRead overrides
	// all of this: "one real reader, safe to recompute inline" only holds within a single execution,
	// which a read from inside another function isn't (see its own comment on Node).
	private isInlinableVarDecl(node: Node): boolean {
		// declKind, not just node.type === 'var': a PARAM is ALSO a bare 'var' node, with its own
		// inputs[0] wired to the function's own entry node (see buildFunctionBody's own param
		// wiring) -- structural plumbing, never a real initializer expression to recompute. It's
		// already correctly handled elsewhere (resolveNode's own no-declKind "read by name" case,
		// no declaration ever needed), and was ONLY ever excluded here as an accidental side effect
		// of isPureSubgraph's own function_decl check (an entry node has no real value, so treating
		// it as a param's own "initializer" and resolving it produces a bare `null` where the param's
		// real value belongs) -- removing isPureSubgraph below re-exposed exactly that, so it's
		// excluded directly now instead of relying on that check's own incidental side effect.
		if (node.type !== 'var' || !node.inputs[0] || node.capturedRead || node.declKind === undefined)
			return false;
		// needsTemp's own "reused more than once, so give it a name" heuristic exists to avoid
		// RECOMPUTING an expression at every read site -- the right tradeoff for something with a
		// real (if cheap) operation, but not for a bare literal: duplicating `false` costs nothing,
		// no matter how many places read it. allowReuse (passed only when the initializer is a
		// literal) exempts JUST that heuristic -- needsTemp's own structural checks (a mu's initial-
		// value port still needing a real, mutable variable to advance the loop, chief among them)
		// stay fully in force regardless, since those are about correctness, not readability (found
		// via a real case: __hit's own declaration is genuinely read twice, by two different tests,
		// but its value is a provably-constant literal -- see switchInternal -- so there's nothing to
		// gain by naming it; a DIFFERENT real case, `let i = 0;` feeding a loop's own mu, is why the
		// exemption can't be broader than that one heuristic).
		// No isPureSubgraph gate any more: every node ALREADY has its own, independent, correct
		// inline-or-materialize decision (an effect included, since valueConsumers(node).length===1
		// -- see emitLocalStatements' own isEffect branch), so a dependency's own impurity is
		// irrelevant here -- init must be OUTPUT before this declaration's own value is ever read
		// regardless (the state chain/scheduling already guarantees that), so whatever effects it
		// contains have already run wherever they needed to by the time anything reads `node`. The
		// only question left for THIS node is its own reuse count. Dropping the gate stopped two
		// real, needless materializations on real code (binary-libs/src/pe.ts): a pure expression
		// merely DERIVED from an effect several hops back (an over-conservative transitive walk that
		// didn't stop at an already-independently-safe intermediate), and a directly effectful
		// initializer with exactly one real reader (redundant now that the effect it wraps already
		// inlines safely on its own).
		return !this.needsTemp(node, this.graph.get(node.inputs[0].nodeId)!.type === 'literal');
	}

	// Conservative, single-pass purity check over `node`'s own transitive inputs: true only if NO
	// effect (call) appears anywhere in the subgraph that produces it.
	private isPureSubgraph(node: Node, seen = new Set<NodeId>()): boolean {
		if (seen.has(node.id))
			return true;
		seen.add(node.id);
		if (node.type === 'effect')
			return false;
		// A method/get/set/static_block's own entry node (see BuildVSDG's buildFunctionBody) has NO
		// input edges at all -- deliberately disconnected from the outer state chain, since a method
		// BODY has no observable ordering effect just from being defined. Without this check,
		// `.inputs.every(...)` on that empty array is vacuously true, wrongly marking it "pure" --
		// which, for a PARAM whose only real reader treats it as inlinable, actually inlines the
		// entry node ITSELF in place of the param's own value (resolveOperand(param.id, 0) follows
		// the param's inputs[0], which IS the entry node -- see functionScope's own param wiring).
		// A top-level function_decl's own entry node never hits this: its inputs[0] is the real
		// outer state predecessor, whose own chain always reaches a genuine 'effect' eventually.
		if (node.type === 'function_decl')
			return false;
		// A PARAMETER's own value is always pure regardless of what's "behind" it (the entry node's
		// own wiring to it, or -- for a top-level function's own params -- the outer state chain
		// beyond that): reading a parameter has no side effect of its own. Recursing PAST it (into
		// its own inputs[0], the entry node) would incorrectly poison every computation that merely
		// READS a param's value based on whatever else happens to run before this function is even
		// called -- entirely unrelated to whether THIS specific computation is safe to inline (found
		// via a real case: `x === 1` inside a switch, x a plain param, was never treated as
		// inlinable, needlessly materializing a real `let` for every case's own match flag).
		if (node.type === 'var' && node.inputs[0] && this.graph.get(node.inputs[0].nodeId)!.type === 'function_decl')
			return true;
		// Skip vestigial edges (see isVestigialEdge's own comment) -- e.g. threadMutation's own
		// scheduling-only marker port: a real graph edge GCM needs, but never part of the actual
		// value computation, so it must not count toward whether THIS subgraph is pure.
		return node.inputs.every((e, port) => !e || node.isVestigialEdge(port) || this.isPureSubgraph(this.graph.get(e.nodeId)!, seen));
	}

	// True if some node OTHER than `excludeId` shares `name` as its own boundName and is
	// forcedPrint -- i.e. will print its own `name = ...;` regardless of what THIS node's own
	// consumer count says, the way every branch of a try/catch merge with no printable condition
	// does (see BuildVSDG's 'try' case). Whether the ORIGINAL declaration can be dropped is not a
	// question this node can answer from its own consumers alone: dropping it while a sibling still
	// prints under the same name would leave that later assignment referencing a name that was never
	// declared. A graph-wide scan (small in practice -- one function body's worth of nodes) is the
	// only way to answer it, since forcedPrint status is finalized during BuildVSDG, well before any
	// of this print-time reasoning runs. switchInternal siblings count too, despite never printing
	// their OWN statement: resolveNode's own switchInternal check (see its comment) guarantees THEY
	// still resolve to Identifier(name) wherever they're READ, which needs `name` declared exactly
	// as much as an ordinary forced statement would (found the hard way: excluding them first caused
	// a real ReferenceError -- __hit's own name referenced by a later case's test, but never declared
	// at all once its own declaration was dropped).
	private hasForcedSibling(name: string, excludeId: NodeId): boolean {
		for (const other of this.graph.values()) {
			if (other.id !== excludeId && other.boundName === name && other.forcedPrint)
				return true;
		}
		return false;
	}

	private emitNamedSlot(name: string, node: Node): Statement | undefined {
		if (node.type === 'var') {
			if (node.inputs[0]) {
				// Either the initializer is pure and doesn't need printing under x's own name
				// (isInlinableVarDecl), or x's value is dead outright regardless of purity -- an
				// effectful dead initializer still needs to RUN (materialized separately as its own
				// statement, via the ordinary isEffect path -- see valueConsumers), just not attached
				// to x: `let x = f();` where x is dead becomes bare `let x;` plus a standalone `f();`.
				if (node.declKind && (this.isInlinableVarDecl(node) || !this.hasRealConsumer(node))) {
					const forcedElsewhere = this.hasForcedSibling(name, node.id);
					// A forced sibling elsewhere still needs `name` to hold the CORRECT value when
					// read. If this node's own value is genuinely dead (hasRealConsumer false), that's
					// fine -- nothing reads it through THIS node either way, so a bare declaration (no
					// initializer) is still correct, just kept (not dropped) so the sibling's `name`
					// exists at all. But if isInlinableVarDecl reached here via literal-duplication
					// (real consumers exist, just cheap to recompute -- e.g. __hit_var8, a literal read
					// by two different tests), going bare would silently replace those reads' value
					// with `undefined` instead of the real one -- fall back to the ordinary,
					// value-bearing declaration instead (found via a real ReferenceError this session:
					// dropping __hit_var8's own value here, while switchInternal still referenced it by
					// name elsewhere, is exactly this case). declaredNames is deliberately NOT set
					// before this call -- declareOrAssign needs to see it as not-yet-declared, to
					// correctly print `let name = ...;` rather than a bare `name = ...;` reassignment.
					if (forcedElsewhere && this.hasRealConsumer(node))
						return this.declareOrAssign(name, node, this.resolveOperand(node.id, 0));
					this.declaredNames.add(name);
					// Safe to drop the bare declaration entirely only when NOTHING else, anywhere,
					// still needs `x` declared; exported bindings keep it too, for the same reason
					// (external code may import it by name, which this graph can't see/track).
					if (!node.exported && !forcedElsewhere)
						return undefined;
					// `const` requires an initializer -- a real one existed in the source (that's the
					// only way declKind could be 'const' here at all), just not printed under x's own
					// name any more (inlined elsewhere, or genuinely dead); downgraded to `let` rather
					// than emitting the syntax-invalid `const x;`.
					return JS.VarDecl(node.declKind === 'const' ? 'let' : node.declKind, JS.Var(name, undefined, node.typeAnnotation)) as Statement;
				}
				return this.declareOrAssign(name, node, this.resolveOperand(node.id, 0));
			}
			this.declaredNames.add(name);
			return JS.VarDecl(node.declKind ?? 'let', JS.Var(name, undefined, node.typeAnnotation)) as Statement;
		}
		if (node.type === 'unary' || node.type === 'unary_post') {
			// A prefix or postfix ++/-- already performs its own assignment as a side effect when
			// evaluated -- printed as a bare expression statement, `++i;`/`i++;` is both correct and
			// sufficient. Routing it through declareOrAssign like an ordinary reassignment would wrap
			// it in a redundant self-assignment: `i = ++i;`/`i = i++;`.
			this.declaredNames.add(name);
			return JS.Expression(this.buildExpr(node)) as Statement;
		}
		return this.declareOrAssign(name, node, this.buildExpr(node));
	}

	resolveOperand(to: NodeId, slot: number): Expr {
		const edge = this.graph.get(to)!.inputs[slot];
		if (!edge)
			throw new Error(`Missing operand edge for slot ${slot} on node ${to}`);
		return this.resolveNode(edge.nodeId);
	}

	resolveNode(id: NodeId): Expr {
		const node = this.graph.get(id)!;

		// switch's own internal bookkeeping (see Node's own field comment) must always resolve by
		// name, regardless of forcedPrint/needsTemp -- its own mutation is structurally never
		// printed, so folding its VALUE into a ternary elsewhere (as an ordinary reassignment might
		// safely do) would be wrong: it'd model a real "did this already happen" merge for a flag
		// that's meant to stay an independent, one-shot value at every read site. Only applies while
		// it's STILL a named slot, though (reconcileVariables clears boundName for an ordinary,
		// non-exiting case exactly like it always did -- that path needs no protecting at all, since
		// there's no downstream "already ran" merge to conflate it with).
		const switchInternalName = node.switchInternal ? node.slotName() : undefined;
		if (switchInternalName !== undefined)
			return Identifier(switchInternalName);

		if (node.type === 'literal')
			return Literal(node.value);

		// A local declaration left bare (see isInlinableVarDecl) never actually assigned its name --
		// its sole reader inlines the (pure) initializer directly instead of reading the name back.
		// Skipped when a forced sibling exists (see hasForcedSibling), though: that guarantees SOME
		// other node sharing this same name resolves via Identifier(name) regardless (an ordinary
		// forced reassignment, or a switchInternal one, see this function's own earlier check) -- if
		// THIS declaration instead inlined its own value, the two would stop being the same
		// expression, and a merge combining them (e.g. __hit's own per-case gammaValue) would lose
		// buildExpr's "cond ? x : x -> x" collapse, printing a real (if always-equivalent) ternary
		// instead of the bare name both sides actually agree on.
		if (node.type === 'var' && this.isInlinableVarDecl(node)
			&& !(typeof node.value === 'string' && this.hasForcedSibling(node.value, node.id)))
			return this.resolveOperand(id, 0);

		// A muValue always corresponds to a real, mutable loop-carried variable, forced to materialize
		// regardless of blocks (needsTemp's own mu/muValue-consumer check) -- always safe to trust by
		// name. (Its own correct PLACEMENT without a block assigned is a separate, still-open gap --
		// see this file's own no-blocks plan -- not addressed here.)
		if (node.type === 'muValue')
			return Identifier(node.value);

		// Params and declared locals alike are just a name to read; whether a DECLARATION statement is
		// also needed for a local is handled separately, by emitLocalStatements's nodeSlotName check.
		// A param (no declKind at all -- it's already bound by the function signature, never printed
		// as its own statement, so declaredNames never sees it) is always safe to trust by name
		// unconditionally. A genuine local declaration (declKind set) has the same declaredNames
		// caveat as the slotName() check above: without a block, nothing may ever have printed it, so
		// fall back to rebuilding the initializer inline instead of trusting an undeclared name --
		// safe here because a bare 'var' read (as opposed to a rebind, which resolves through a
		// DIFFERENT, boundName-tagged node instead) always means "this exact declaration's own
		// initializer", never a value some later reassignment produced.
		if (node.type === 'var' && typeof node.value === 'string') {
			if (!node.declKind || this.declaredNames.has(node.value))
				return Identifier(node.value);
			return this.resolveOperand(id, 0);
		}

		// A thetaValue's exported value IS its mu source's value, unchanged -- it exists only to mark
		// where a loop-carried variable becomes readable again after the loop, not to compute
		// anything itself.
		if (node.type === 'thetaValue')
			return this.resolveOperand(id, 1);

		// declaredNames confirms `name`'s own statement was ACTUALLY printed somewhere reachable, not
		// just that isInlinableSlot considers it worth a name -- without a block to schedule it, that
		// statement may never have been visited at all (same failure mode isInlinableSlot's own
		// comment already documents for a no-real-effect gammaValue). Falls through to the same
		// rebuild-inline path below when it wasn't, instead of trusting an undeclared identifier.
		const name = node.slotName();
		if (name !== undefined && !this.isInlinableSlot(node) && this.declaredNames.has(name))
			return Identifier(name);

		const varName = this.nodeVariableNames.get(id);
		if (varName)
			return Identifier(varName);

		// Not materialized as a statement anywhere reachable -- most commonly a pure value (e.g. one
		// branch's reassignment candidate, now feeding only a per-variable named gamma) whose own
		// block was never visited, because a no-real-effect if/else has no structural wrapper for
		// Output's own emitChain to reach it through. Building it inline is always safe for a pure value: it just
		// recomputes the same result on demand. It's NOT safe for an effect (a call) -- buildExpr has
		// no case for those (type 'effect'; isEffect-classified nodes are always handled directly by
		// emitLocalStatements) and falls through to its own default, so this can't accidentally
		// duplicate a call's execution the way inlining it here would.
		return this.buildExpr(node);
	}

	// A simple local dependency sorter for a single block's nodes
	localTopologicalSort(ids: NodeId[]): NodeId[] {
		const sorted: NodeId[] = [];
		const visited = new Set<NodeId>();
		const nodeSet = new Set(ids);
		// Separate from `visited`: tracks nodes OUTSIDE nodeSet already searched through, below --
		// never pushed to `sorted` themselves (they're not being ordered, just walked past), but
		// still need their own cycle guard.
		const walkedThrough = new Set<NodeId>();

		// mu/theta/literal (and a var with no declKind -- a bare read, not a declaration: see below)
		// resolve directly (a name lookup or a constant), never by combining their own inputs -- in
		// particular, a mu's port-1 feedback edge points at whatever the loop body computes from the
		// mu ITSELF, so following it here as an ordinary "compute this first" dependency is both
		// unnecessary (the mu never needs it to resolve) and cyclic.
		const hasOrderedInputs = (node: Node) =>
			node.type !== 'mu' && node.type !== 'muValue' && node.type !== 'theta' && node.type !== 'thetaValue' && node.type !== 'literal'
			&& (node.type !== 'var' || node.declKind !== undefined);

		// Before emitting `node`, everything it depends on must be emitted first -- including
		// TRANSITIVELY, through an input that's itself inlined (not its own nodeSet member, so
		// never separately visited/printed): e.g. `let e = i + len;` where `i + len` never gets its
		// own statement, only its dependency on `i` does, is still a real ordering constraint on `e`
		// (found the hard way, testing a real file: without this, `i`/`e`'s relative order was
		// undefined, silently printing `let e = i + len; let i = off;` -- reading `i` before its own
		// declaration).
		const visitDeps = (node: Node) => {
			if (!hasOrderedInputs(node))
				return;
			for (const edge of node.inputs) {
				if (!edge)
					continue;
				if (nodeSet.has(edge.nodeId)) {
					visit(edge.nodeId);
				} else if (!walkedThrough.has(edge.nodeId)) {
					walkedThrough.add(edge.nodeId);
					visitDeps(this.graph.get(edge.nodeId)!);
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
			visitDeps(this.graph.get(id)!);
			sorted.push(id);
		};

		for (const id of ids)
			visit(id);

		return sorted;
	}

	emitLocalStatements(ids: NodeId[]): Statement[] {
		const statements: Statement[] = [];

		for (const id of this.localTopologicalSort(ids)) {
			const node = this.graph.get(id)!;

			// A user-written break/continue: unlike every other bare 'effect' marker (MUTATION_MARKER,
			// PROGRAM_START, ...), this one DOES need a real printed statement -- it's what real JS
			// routes to the nearest enclosing loop/switch at runtime. See BuildVSDG's 'break'/'continue'
			// case for why nothing here needs to track WHICH loop/switch it targets.
			if (node.type === 'effect' && (node.value === 'BREAK_MARKER' || node.value === 'CONTINUE_MARKER')) {
				statements.push({ type: node.value === 'BREAK_MARKER' ? 'break' : 'continue' } as Statement);
				continue;
			}

			// Same idea, but carries a real value: its own input at port 1 is the thrown
			// expression, evaluated once when the throw statement was originally walked.
			if (node.type === 'effect' && node.value === 'THROW_MARKER') {
				statements.push({ type: 'throw', argument: this.resolveOperand(id, 1) } as Statement);
				continue;
			}

			// Same idea again, for `return`: port 1 carries the returned value, left UNCONNECTED for a
			// bare `return;` (unlike throw, whose argument is mandatory) -- this is what makes an early
			// return, nested inside a branch, print correctly in place instead of being silently
			// dropped or merged against a value from a branch that never returned at all (see
			// BuildVSDG's 'return' case for the full reasoning).
			if (node.type === 'effect' && node.value === 'EARLY_RETURN_MARKER') {
				statements.push({ type: 'return', argument: node.inputs[1] ? this.resolveOperand(id, 1) : undefined } as Statement);
				continue;
			}

			if (this.isEffect(node)) {
				// A call is safe to inline (skip its own `var tN = f();`) whenever it has EXACTLY ONE
				// real value consumer -- not the narrower isInlinableEffect it used to be gated on,
				// which also required that consumer to be the call's own DIRECT state-chain successor.
				// That extra requirement isn't actually load-bearing: an effect is always rootBlocks-
				// anchored to its own fixed position (never GCM-floating), so a pure node consuming it
				// already has its own scheduleEarly/scheduleLate window floored/capped at that fixed
				// position, and buildExpr always reconstructs an operand chain in the same left-to-right
				// order BuildVSDG threaded the underlying effects into the state chain -- so inlining
				// through an arbitrary pure single-consumer chain (not just another call, or a rebind's
				// own marker) preserves the required order regardless (found via a real duplicated pair
				// of temps on real code, binary-libs/src/pe.ts: `t44 = uint16.get(...); t45 =
				// bin.text.stringCode("MZ"); return t44 === t45;`, where each side had exactly one real
				// consumer -- the `===` -- but neither matched isInlinableEffect's narrower shape).
				// valueConsumers, not needsTemp: needsTemp's own consumer count is shared by every OTHER
				// caller (reassignments, mu/rebind forcing, loop-hoisting), and reusing needsTemp itself
				// here (routing an effect's count through the exact same shared function) turned out to
				// change those OTHER callers' behavior too -- content silently vanished from reconstructed
				// loop bodies in testing. valueConsumers alone, called directly, keeps the blast radius
				// to just this decision.
				if (this.valueConsumers(node).length === 1)
					continue; // deferred -- the sole consuming call inlines it via resolveNode's fallback
				statements.push(
					this.hasValueConsumer(node)
						? JS.VarDecl('var', JS.Var(this.makeTempVar(id), this.buildEffectExpr(node))) as Statement
						: JS.Expression(this.buildEffectExpr(node)) as Statement
				);
				continue;
			}

			const name = node.slotName();
			if (name !== undefined) {
				// A plain reassignment (`x = ...;`) or a named merge (`x = a ? ... : ...;`) is only
				// worth printing under x's own name if it's genuinely reused -- same test as an
				// anonymous temp (needsTemp). A single real consumer -- whether that's the very next
				// statement (`x = 2; f(x);` inlining into `f(2);`) or an ENCLOSING merge reading this
				// one as its own operand (a named gamma feeding another named gamma, e.g. an
				// `else if` chain) -- can always resolve it lazily via resolveNode's own matching
				// check instead. forcedPrint overrides this: a reassignment on a branch that exited
				// has no merge to inline into at all (see its own comment) and must always print.
				if (this.isInlinableSlot(node))
					continue;
				// A named except never gets a statement of its OWN: unlike a gamma, there's no
				// printable condition to build `x = cond ? a : b;` from, so each branch already
				// prints its own `x = ...;` directly (forcedPrint, see BuildVSDG's 'try' case) --
				// this node exists purely so GCM schedules downstream readers of `x` correctly,
				// never to be materialized itself.
				if (node.type === 'except')
					continue;
				const namedStmt = this.emitNamedSlot(name, node);
				if (namedStmt)
					statements.push(wrapExported(namedStmt, node.exported));
				continue;
			}

			switch (node.type) {
				case 'literal':
				case 'var':
				case 'mu':
				case 'muValue':
				case 'theta':
				case 'thetaValue':
				case 'effect':
					// No statement of their own: literals/vars/mu/muValue/theta/thetaValue are read
					// directly by
					// resolveNode, and non-call effect nodes reaching here (RETURN_ANCHOR,
					// MUTATION_MARKER, PROGRAM_START, ...) are internal bookkeeping markers with no
					// source-level representation -- BREAK/CONTINUE/THROW/EARLY_RETURN markers are
					// already intercepted earlier, above, before ever reaching this switch.
					break;

				case 'passthru':
					// Every declaration type reaching here (interface/type-alias/enum/namespace/...) is
					// genuinely codeless from VSDG's own perspective, or not yet decomposed -- node.value
					// prints verbatim, as its own real statement (a declaration always prints regardless
					// of whether it's ever referenced, same as var_decl -- unlike an ordinary value,
					// there's no "unused, so inline or drop it" question for one). wrapExported restores
					// `export `/`export default ` when this declaration came from one.
					statements.push(wrapExported(node.value as Statement, node.exported));
					break;

				case 'class_decl':
					// Its own type tag (not folded into 'passthru', which used to need a runtime
					// `typeof node.value === 'object' && node.value.type === 'class_decl'` check here to
					// tell "this passthru is actually a resolved class" apart from "this one's really
					// verbatim") -- see BuildVSDG's own 'class_decl' case for why that shared-tag-
					// disambiguated-by-value shape was worth splitting out. rebuildClass splices VSDG's
					// own resolution of the heritage/keys/method-bodies back into the otherwise-verbatim
					// class before printing.
					statements.push(wrapExported(this.rebuildClass(node.value, node.classInfo!), node.exported));
					break;

				case 'function_decl':
					// Always intercepted earlier, by emitFrom's own per-block dispatch (function_decl
					// is a rootBlocks anchor, always alone in its own block) -- reaching here would mean
					// that dispatch was skipped somehow. No-op rather than silently mis-printing it as
					// an ordinary unresolved value.
					break;

				default:
					// forcedPrint: an unnamed node with a real side effect but no value consumer at all
					// (a property/index assignment -- see BuildVSDG's 'binary' case) -- needsTemp alone
					// would see zero consumers and conclude it's safe to drop entirely, which is only
					// true for an actual PURE value, never for an effect nothing happens to read back.
					// Built directly here, not via buildExpr's own 'binary' case: THAT one assumes an
					// assignment reaching it is being read as a VALUE (superseded by an if/else merge,
					// e.g. `y = (x = 1)`), so it deliberately returns just the right-hand value, not
					// `left = right` -- exactly wrong for printing the assignment itself as a statement.
					if (node.forcedPrint) {
						statements.push(JS.Expression({ ...(node.value as Expr & { type: 'binary' }), left: this.resolveOperand(node.id, 0), right: this.resolveOperand(node.id, 1) }) as Statement);
					} else if (this.needsTemp(node)) {
						statements.push(JS.VarDecl('var', JS.Var(this.makeTempVar(id), this.buildExpr(node))));
					}
					// else: single-use, same-block -- left unmaterialized; its sole consumer inlines it
					// directly via resolveNode's fallback when it resolves this operand.
			}
		}

		return statements;
	}

	// True for a node reached via the state chain's own port-2 "triggering rebind" convention (see
	// BuildVSDG's threadMutation/rebindVar) whose statement must be printed under its own name
	// regardless of block placement: a rebind (compound-assign/++/--), or a genuine local
	// declaration (declKind set) -- unlike a gammaValue/named-except merge (a pure, non-effectful
	// value with no state anchor at all), both of these are the ONLY named slots that use this
	// port-2 convention, so this stays narrow rather than matching slotName() broadly.
	private needsDirectPlacement(node: Node): boolean {
		if (!isOwnAnchorTarget(node))
			return false;
		// Unlike ++/--/unary_post (an intrinsic side effect -- always prints, with or without a real
		// consumer, matching emitNamedSlot's own unconditional handling of those two types), a plain
		// binary reassignment CAN be genuinely dead (isInlinableSlot already decides this correctly,
		// block-independent -- it's pure graph structure, not GCM output) -- respect that instead of
		// force-materializing every one found this way, or a dead `__hit_var4 = true;` etc. would
		// print here that GCM would otherwise have silently never scheduled anywhere reachable.
		// isInlinableVarDecl/hasRealConsumer-driven elision for a genuinely dead 'var' declaration
		// already lives entirely inside emitNamedSlot (down to a bare `let x;` or nothing at all),
		// so a 'var' is always safe to force-include unconditionally here and let it make that call.
		return node.type !== 'binary' || !this.isInlinableSlot(node);
	}

	// Which nodes GCM scheduled alongside a given control-anchor node (blockNodes, keyed via the
	// anchor's own block id -- see the constructor's own comment on blockIds/blockControl).
	// Without an assigned block, still returns [anchorId] itself, not []: GCM's own convention (an
	// anchor is always a member of its OWN block) is what lets emitControlNode's default case print
	// an ordinary effect/call by simply being one of the ids handed to emitLocalStatements -- lose
	// that and the anchor would never be discovered at all. Every OTHER emitControlNode case already
	// excludes control.id from what it hands to emitLocalStatements itself (it builds that node's own
	// statement directly instead), so including it here is harmless for them too.
	//
	// ALSO checks for a rebind (compound-assign/++/--) whose own state-anchor trigger (port 2, the
	// same convention BuildVSDG's own reassignment machinery always uses -- see e.g. its 'unary'
	// case) is this anchor: needsTemp forces such a node to materialize under its own name
	// regardless of reuse count, so unlike an ordinary pure value it can't safely fall back to
	// resolveNode's inline-duplicate path when GCM never scheduled it anywhere -- it needs a real,
	// single, correctly-positioned statement, and this MUTATION_MARKER anchor (always visited
	// directly by emitChain, block or no block) is the only point that can still give it one.
	private nodesAt(anchorId: NodeId): NodeId[] {
		const bId = this.blockIds?.get(anchorId);
		if (bId !== undefined)
			return this.blockNodes(bId);
		const ids = [anchorId];
		for (const edges of this.graph.get(anchorId)!.outputs) {
			if (!edges)
				continue;
			for (const e of edges) {
				if (e.port === 2 && this.needsDirectPlacement(this.graph.get(e.nodeId)!))
					ids.push(e.nodeId);
			}
		}
		return ids;
	}

	// Reconstructs the statement span (fromId, boundaryId] -- i.e. everything from fromId back to
	// (not including) boundaryId, in original execution order -- by walking inputs[0] backward
	// (always exactly one real state predecessor per control-anchor node, by construction) and
	// appending this node's own contribution AFTER recursing into its predecessor, so output comes
	// out forward despite the recursion going backward. Replaces the old forward walk (successorBlock
	// + emitFrom's while loop), which needed a fallback heuristic to disambiguate several simultaneous
	// forward consumers of the same state token (each branch's own entry AND the eventual merge all
	// read the branch point as their own predecessor) -- a backward walk from a KNOWN endpoint has no
	// such ambiguity: there's only ever one predecessor to ask for.
	private emitChain(fromId: NodeId | undefined, boundaryId: NodeId): Statement[] {
		if (fromId === undefined || fromId === boundaryId)
			return [];
		const node = this.graph.get(fromId)!;
		// A state-theta's own predecessor (inputs[0]) IS its loop's mu (see buildLoop) -- theta has no
		// printable statement of its own; the whole loop, including whatever theta's own co-scheduled
		// locals need, is reconstructed once, by the mu, when the recursion reaches it via this skip.
		if (node.type === 'theta')
			return this.emitChain(node.inputs[0]?.nodeId, boundaryId);
		return [...this.emitChain(node.inputs[0]?.nodeId, boundaryId), ...this.emitControlNode(node)];
	}

	// This control-anchor node's OWN contribution to its enclosing statement list -- the reconstructed
	// if/switch/try/while/function declaration it anchors (plus whatever pure nodes GCM scheduled
	// right alongside it), or (the default case) just those pure nodes, for an anchor with no nested
	// structure of its own (an ordinary call, a declaration, PROGRAM_START, ...).
	private emitControlNode(control: Node): Statement[] {
		const nodes = this.nodesAt(control.id);

		if (control.type === 'gamma') {
			// Anything else GCM scheduled alongside the merge itself needs to be split by whether it's
			// a DEPENDENCY of the gamma (e.g. a `let a = ...;` the test itself reads -- must print
			// BEFORE the if) or a DEPENDENT of it (reads the merged result -- prints after). Computed,
			// and the "before" half emitted, BEFORE the branches themselves: a value CSE shared between
			// a branch's own content and this gamma's own co-scheduled slot (the exact shape a value
			// used by BOTH a sibling branch and the code after it takes -- see optimizeStructuralCSE)
			// must already be registered in nodeVariableNames by the time the branch tries to resolve
			// it, or it silently re-resolves/duplicates instead of referencing the shared temp (found
			// the hard way: wiring CSE into the real pipeline surfaced this immediately).
			const sortedIds	= this.localTopologicalSort(nodes);
			const gammaIndex	= sortedIds.indexOf(control.id);
			const beforeStmts	= this.emitLocalStatements(sortedIds.slice(0, gammaIndex));

			// Ports: 0 = predecessor, 1 = condition, 2 = true tail, 3 = false tail.
			const predecessorId	= control.inputs[0].nodeId;
			const trueStmts		= this.emitChain(control.inputs[2].nodeId, predecessorId);
			// A false tail that never got anywhere past the branch point (no real content) means
			// there's no `else` at all -- as opposed to one that's genuinely empty, which still prints
			// `else {}` (see JS.If's own falseStmts check just below).
			const falseStmts		= control.inputs[3].nodeId !== predecessorId ? this.emitChain(control.inputs[3].nodeId, predecessorId) : undefined;

			return [
				...beforeStmts,
				JS.If(
					this.resolveOperand(control.id, 1),
					JS.Block(...trueStmts as JS.Statement<any>[]),
					falseStmts ? JS.Block(...falseStmts as JS.Statement<any>[]) : undefined
				) as Statement,
				...this.emitLocalStatements(sortedIds.slice(gammaIndex + 1)),
			];
		}

		if (control.type === 'break_scope') {
			// Reconstructed as a REAL `switch`/`case`. break_scope has exactly one creation site (see
			// BuildVSDG's own 'switch' case), which always stamps switchCases right before returning
			// -- relied on unconditionally here, not re-checked. Each case's own body is found the
			// same way a gamma's branches are.
			// Computed, and the "before" half emitted, BEFORE each case's own content -- same reasoning
			// as the gamma case just above (a CSE-shared value scheduled here must already be
			// registered before a case tries to resolve it).
			const sortedIds	= this.localTopologicalSort(nodes);
			const scopeIndex	= sortedIds.indexOf(control.id);
			const beforeStmts	= this.emitLocalStatements(sortedIds.slice(0, scopeIndex));

			// The discriminant's (and each case test's) own GCM schedule is driven entirely by its
			// GRAPH consumers -- the now-bypassed "hit || matchN" test machinery -- since resolving
			// it for PRINTING here is a plain value lookup, not a graph edge GCM ever saw. That
			// usually places it somewhere this reconstruction never otherwise visits, so it needs
			// forcing here or it silently never prints -- unless some OTHER surviving value already
			// forced it under its own name first (checked via declaredNames, to avoid a duplicate).
			const forceDeclare = (id: NodeId): Statement[] => {
				const n = this.graph.get(id)!;
				return n.type === 'var' && typeof n.value === 'string' && !this.declaredNames.has(n.value)
					? this.emitLocalStatements([id]) : [];
			};
			const cases = control.switchCases!.map(c => ({
				test:		c.testNodeId ? this.resolveNode(c.testNodeId) : undefined,
				consequent:	this.emitChain(c.tailId, c.boundaryId) as JS.Statement<any>[],
			}));

			// Once every case's own value has been elided into the post-switch merge (see
			// isLoopCarried's own comment -- exactly the shape a break-ending case with only a
			// pure reassignment reduces to), a case's own body can end up with NOTHING left to run
			// except its own trailing `break;` -- which, if EVERY case (and default, if present)
			// is in that same shape, has nothing left to jump PAST either: every entry point,
			// direct match or fallthrough, does nothing and falls out the same way regardless.
			// The whole dispatch is then observably a no-op and can be dropped entirely -- NOT
			// just each case's own reassignment the way isInlinableSlot already elides individual
			// values. A `continue`/`return`/`throw` (a jump somewhere OTHER than "right after the
			// switch") is real content and blocks this, unlike a bare `break`.
			const isNoOp = (stmts: JS.Statement<any>[]) => stmts.length === 0 || (stmts.length === 1 && stmts[0].type === 'break');
			const switchIsNoOp = cases.every(c => isNoOp(c.consequent));

			return [
				...beforeStmts,
				...forceDeclare(control.switchDiscriminantId!),
				...control.switchCases!.flatMap(c => c.testNodeId ? forceDeclare(c.testNodeId) : []),
				...(switchIsNoOp ? [] : [JS.Switch(this.resolveNode(control.switchDiscriminantId!), ...cases) as Statement]),
				...this.emitLocalStatements(sortedIds.slice(scopeIndex + 1)),
			];
		}

		if (control.type === 'except' && typeof control.value !== 'string') {
			// Computed, and the "before" half emitted, BEFORE try/catch/finally's own content -- same
			// reasoning as the gamma case above.
			const sortedIds		= this.localTopologicalSort(nodes);
			const exceptIndex	= sortedIds.indexOf(control.id);
			const beforeStmts	= this.emitLocalStatements(sortedIds.slice(0, exceptIndex));

			// Ports: 0 = predecessor, 1 = try's own tail, 2 = catch's own tail, 3 = finally's own tail.
			const predecessorId	= control.inputs[0].nodeId;
			const tryStmts		= this.emitChain(control.inputs[1].nodeId, predecessorId);
			const catchStmts	= this.emitChain(control.inputs[2].nodeId, predecessorId);
			// finally's own tail (port 3) is anchored back on `control` itself, not `predecessorId` --
			// its own first statement's predecessor is the except node directly (see BuildVSDG's 'try'
			// case), not the state from before the whole try/catch.
			const finallyEdge	= control.inputs[3];
			const finallyStmts	= finallyEdge ? this.emitChain(finallyEdge.nodeId, control.id) : undefined;

			return [
				...beforeStmts,
				{
					type:			'try',
					block:			tryStmts as JS.Statement<any>[],
					handlerParam:	control.catchParam,
					handlerBody:	catchStmts as JS.Statement<any>[],
					finalizer:		finallyStmts as JS.Statement<any>[] | undefined,
				} as Statement,
				...this.emitLocalStatements(sortedIds.slice(exceptIndex + 1)),
			];
		}

		if (control.type === 'function_decl') {
			// Before, then body -- same reasoning as the gamma case above (a function's own body is
			// its own separate scope, so this is lower-risk than the branch cases, but kept consistent).
			const sortedIds			= this.localTopologicalSort(nodes);
			const declIndex			= sortedIds.indexOf(control.id);
			const beforeStmts			= this.emitLocalStatements(sortedIds.slice(0, declIndex));
			const bodyStatements	= this.reconstructFunctionBody(control);
			return [
				...beforeStmts,
				wrapExported({ ...this.rebuildParams(control.value as JS.FunctionDecl<any>, control), body: bodyStatements } as Statement, control.exported),
				...this.emitLocalStatements(sortedIds.slice(declIndex + 1)),
			];
		}

		if (control.type === 'mu') {
			const thetaEdge	= (control.outputs[0] ?? []).find(e => this.graph.get(e.nodeId)!.type === 'theta');
			const thetaNode	= thetaEdge && this.graph.get(thetaEdge.nodeId)!;

			// The mu's own block holds the mu node itself plus any loop-body computation whose only
			// real dependency IS the mu (e.g. `i = i + 1;` with no calls in the body) -- GCM schedules
			// those into the mu's own block since there's no other anchor to place them at. Anything
			// with a real effect continues from the body's own entry, via port 1 (the feedback input).
			const ownIds		= nodes.filter(id => id !== control.id);

			const statements: Statement[] = [];

			if (thetaNode) {
				const testId	= thetaNode.inputs[1].nodeId;
				const testNode	= this.graph.get(testId)!;
				// The test's only REAL reader (besides itself) is normally the state-theta's own
				// condition port -- everything else pointing at it (each named theta's own condition
				// port, one per loop-carried variable) is vestigial, never actually read by codegen.
				const onlyReadByLoopExit = (testNode.outputs[0] ?? []).filter(e => !this.graph.get(e.nodeId)!.isVestigialEdge(e.port))
					.every(e => e.nodeId === thetaNode.id);
				// Emitted BEFORE restOfBody (the loop body's own content, below) -- same reasoning as
				// the gamma case above: a value CSE shares between the mu's own co-scheduled slot and
				// the body itself must already be registered by the time the body tries to resolve it.
				const testStatements	= onlyReadByLoopExit ? [] : this.emitLocalStatements([testId]);
				const restStatements	= this.emitLocalStatements(ownIds.filter(id => id !== testId));
				const restOfBody		= this.emitChain(control.inputs[1].nodeId, control.id);

				if (control.loopKind === 'do') {
					// No rotation needed: the body already runs before the test in do-while's own
					// native semantics (the mu's INITIAL value is what the body sees on its first pass).
					statements.push(JS.DoWhile(JS.Block(
						...restOfBody as JS.Statement<any>[],
						...restStatements as JS.Statement<any>[],
						...testStatements as JS.Statement<any>[]
					), this.resolveOperand(thetaNode.id, 1)) as Statement);
				} else {
					// LOOP ROTATION: the condition needs values that only exist once already inside the
					// loop body, so `while (cond) { ... }` is structurally impossible here --
					// `while (true) { <compute cond>; if (!cond) break; body }` isn't. A condition that
					// resolves to the literal `true` (a real `for(;;)`, or any desugaring -- e.g.
					// for-of/for-in's own iterator-protocol loop -- that hands buildLoop a
					// compile-time-constant test) makes the check provably dead: `if (!true)` never
					// runs its `break`, so it's dropped instead of printed as inert clutter.
					const condExpr = this.resolveOperand(thetaNode.id, 1);
					statements.push(JS.While(Literal(true), JS.Block(
						...testStatements as JS.Statement<any>[],
						...(condExpr.type === 'literal' && condExpr.value === true ? [] : [JS.If({ type: 'unary', operator: '!', operand: condExpr } as Expr,
							JS.Block({ type: 'break' } as JS.Statement<any>)
						) as JS.Statement<any>]),
						...restStatements as JS.Statement<any>[],
						...restOfBody as JS.Statement<any>[]
					)) as Statement);
				}
			} else {
				// No exit condition could be found at all (shouldn't normally happen -- every `while`
				// creates a state-theta) -- fall back to reconstructing without rotation. Own content
				// emitted before restOfBody, same reasoning as the thetaNode branch above.
				const restStatements = this.emitLocalStatements(ownIds);
				const restOfBody = this.emitChain(control.inputs[1].nodeId, control.id);
				statements.push(JS.While(Literal(true),
					JS.Block(...restStatements as JS.Statement<any>[], ...restOfBody as JS.Statement<any>[])
				) as Statement);
			}

			if (thetaNode) {
				// Anything scheduled into the state-theta's OWN block (besides the theta node itself)
				// needs to be emitted explicitly here, right after the loop: a pure computation that
				// depends only on a named theta's exported value has nothing to state-chain through, so
				// the recursive walk would never otherwise find it.
				statements.push(...this.emitLocalStatements(this.nodesAt(thetaNode.id).filter(id => id !== thetaNode!.id)));
			}

			return statements;
		}

		return this.emitLocalStatements(nodes);
	}

	// Reconstructs a 'function_decl'-anchored subgraph's own body (a top-level function, or a class
	// method/get/set/static_block -- see BuildVSDG's buildFunctionBody) -- its own fully independent
	// region (own entry/RETURN_ANCHOR pair, own scope). returnNodeId (stamped in BuildVSDG) is the
	// only way to find the RETURN_ANCHOR from here -- there's no ordinary graph edge from entry to
	// return that survives an EMPTY body (see the Node field's own comment).
	private reconstructFunctionBody(entryNode: Node): Statement[] {
		const returnNode		= this.graph.get(entryNode.returnNodeId!)!;
		// A fresh declaredNames frame per function body (see ScopedNames' own comment): this
		// function's own locals must never collide with -- or be shadowed by -- an unrelated
		// sibling/enclosing function's locals that merely happen to share a name.
		this.declaredNames.push();
		const bodyStatements	= this.emitChain(returnNode.inputs[0].nodeId, entryNode.id);

		const returnValueNode = this.graph.get(returnNode.inputs[1].nodeId)!;
		// Both "no return statement at all" and a bare `return;` fall back to the SAME synthetic
		// literal(undefined) -- indistinguishable from an explicit `return undefined;` here, but all
		// three are runtime-equivalent, so omitting the trailing statement is never wrong.
		if (!(returnValueNode.type === 'literal' && returnValueNode.value === undefined))
			bodyStatements.push({ type: 'return', argument: this.resolveOperand(returnNode.id, 1) } as Statement);
		this.declaredNames.pop();
		return bodyStatements;
	}

	// A single-expression counterpart to reconstructFunctionBody, for an INSTANCE field's own
	// initializer (see BuildVSDG's buildClassMember, which passes `m.value` directly as an EXPRESSION
	// body -- the same shape an expression-bodied arrow uses, not a statement list, so there's no
	// EARLY_RETURN_MARKER involved at all). returnNode's own port 1 IS where the value lives here.
	private resolveFieldInitializer(entryNode: Node): Expr {
		const returnNode = this.graph.get(entryNode.returnNodeId!)!;
		return this.resolveOperand(returnNode.id, 1);
	}

	// The whole program's own statement list -- PROGRAM_START's own co-scheduled locals (there's
	// nothing before it to recurse into), followed by everything else, walked backward from
	// programEndId (see the Node field's own comment) down to PROGRAM_START itself. 'block_entry' is
	// still GCM's own fixed, well-known id for PROGRAM_START (see buildBlockTree), reused here purely
	// to recover its real NodeId via blockControl when available. Without blockControl (or without a
	// 'block_entry' entry in it), PROGRAM_START is found the same way buildBlockTree itself identifies
	// it -- by type and value -- so this still works with no GCM output at all.
	buildProgram(): Statement[] {
		const programStartId = this.blockControl?.get('block_entry')
			?? [...this.graph.values()].find(n => n.type === 'effect' && n.value === 'PROGRAM_START')?.id;
		if (!programStartId)
			return [];
		const programStart = this.graph.get(programStartId)!;
		return [...this.emitControlNode(programStart), ...this.emitChain(programStart.programEndId, programStartId)];
	}
}

function foldConstants(graph: VSDG, node: Node): boolean {
	switch (node.type) {
		case 'binary': {
			// Find the incoming value edges for this node
			const leftEdge	= graph.getEdge0(node, 0);
			const rightEdge	= graph.getEdge0(node, 1);
			if (!leftEdge || !rightEdge)
				return false;

			// Get the actual source nodes
			const left	= graph.getNode(leftEdge.nodeId);
			const right = graph.getNode(rightEdge.nodeId);

			// If both inputs are constants, we can fold them!
			if (left.type === 'literal' && right.type === 'literal') {
				const expr = node.value as (Expr & {type: 'binary'});
				const r = calcBinary(expr.operator, left.value, right.value);
				if (r !== undefined) {
					// 1. Change this node into a pure Constant node
					node.type = 'literal';
					node.value = r;

					// 2. Remove the incoming edges since it no longer computes anything
					graph.removeInputs(node);
					return true; // Graph was modified!
				}
			}
			return false;
		}
		case 'unary': {
			const edge = graph.getEdge0(node, 0);
			if (!edge)
				return false;

			const operand	= graph.getNode(edge.nodeId);
			if (operand.type === 'literal') {
				const expr = node.value as (Expr & {type: 'unary'});
				const r = calcUnary(expr.operator, operand.value);
				if (r !== undefined) {
					// 1. Change this node into a pure Constant node
					node.type = 'literal';
					node.value = r;

					// 2. Remove the incoming edges since it no longer computes anything
					graph.removeInputs(node);
					return true; // Graph was modified!
				}
			}
			return false;
		}
	}
	return false;
			
}


// Every NodeId referenced OUTSIDE the ordinary inputs/outputs edge graph -- switchDiscriminantId/
// switchCases (BuildVSDG's own 'switch' case), returnNodeId/programEndId (function_decl/
// PROGRAM_START's own anchors), classInfo's superClassNodeId and each member's keyNodeId/
// entryNodeId/valueNodeId (BuildVSDG's own buildClass). None of foldConstants/foldDeadBranches/
// optimizeStructuralCSE know about these side channels -- they only rewire inputs/outputs -- so a
// node reachable ONLY this way must never be removed/merged away, or the reference left pointing
// at a deleted id (found the hard way: optimizeStructuralCSE merging a switch case's own literal
// test value into an earlier structurally-identical literal elsewhere left switchCases[].testNodeId
// dangling, crashing resolveNode). These fields are stamped once during BuildVSDG and never
// revisited by any of the three passes, so the protected set is stable for one whole Optimize call.
function collectProtectedNodeIds(graph: VSDG): Set<NodeId> {
	const ids = new Set<NodeId>();
	for (const node of graph.values()) {
		if (node.returnNodeId !== undefined)
			ids.add(node.returnNodeId);
		if (node.programEndId !== undefined)
			ids.add(node.programEndId);
		if (node.switchDiscriminantId !== undefined)
			ids.add(node.switchDiscriminantId);
		for (const c of node.switchCases ?? []) {
			if (c.testNodeId !== undefined)
				ids.add(c.testNodeId);
			ids.add(c.boundaryId);
			ids.add(c.tailId);
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

export function Optimize(graph: VSDG): void {
	const protectedIds = collectProtectedNodeIds(graph);
	let changed = true;

	while (changed) {
		changed = false;

		for (const node of graph.values()) {
			// 1. Try to fold constant math operations
			if (foldConstants(graph, node))
				changed = true;

			// 2. Try to eliminate dead if/else branches
			if (foldDeadBranches(graph, node, protectedIds))
				changed = true;
		}

		// 3. Merge structurally-identical pure computations -- runs once per round (it's a
		// whole-graph pass, not a per-node check like the two above), each round: constant
		// folding can turn two previously-different expressions into identical ones, and CSE
		// merging two nodes can turn a previously-non-constant condition into one, so a single
		// pass over each in isolation wouldn't converge on everything reachable together.
		if (optimizeStructuralCSE(graph, protectedIds))
			changed = true;
	}
}


function foldDeadBranches(graph: VSDG, node: Node, protectedIds: Set<NodeId>): boolean {
	// We are looking for Gamma nodes (gammaValue or the state gamma)
	if (node.type !== 'gamma' && node.type !== 'gammaValue')
		return false;
	// Never remove a node some out-of-band NodeId field still points at -- see
	// collectProtectedNodeIds's own comment. A gamma/gammaValue isn't a typical side-channel
	// target, but this stays a real guard rather than an assumption.
	if (protectedIds.has(node.id))
		return false;

	// A gammaValue has [condition, true, false] at ports 0/1/2; the state gamma has an extra
	// state-predecessor at port 0, shifting those three to ports 1/2/3.
	const port = node.type === 'gammaValue' ? 0 : 1;

	// Find the edge supplying the condition
	const condEdge = graph.getEdge0(node, port);
	if (!condEdge)
		return false;

	const condNode = graph.getNode(condEdge.nodeId);

	// If the condition is a known constant boolean (or truthy/falsy value)
	if (condNode.type === 'literal') {
		// Find the edge representing the winning path (true path, then false path)
		const winningEdge = graph.getEdge0(node, condNode.value ? port + 1 : port + 2);
		if (!winningEdge)
			return false;

		// Bypass this Gamma node entirely!
		// Find every downstream node that reads from this Gamma node,
		// and reconnect them to read directly from the winning branch source. Each entry in
		// node.outputs[port] is CONSUMER-shaped ({nodeId: consumer, port: consumer's own slot}),
		// the opposite shape from winningEdge (PRODUCER-shaped) -- the consumer's own inputs[]
		// entry is what actually needs to change, and winningNode's outputs[] needs a fresh,
		// correctly-shaped descriptor, not the mutated consumer-side one (same pattern
		// optimizeStructuralCSE already uses correctly, just below).
		const winningNode = graph.getNode(winningEdge.nodeId);
		for (const subscribers of node.outputs) {
			for (const consumerEdge of subscribers) {
				graph.getNode(consumerEdge.nodeId).inputs[consumerEdge.port] = { nodeId: winningEdge.nodeId, port: winningEdge.port };
				(winningNode.outputs[winningEdge.port] ??= []).push({ nodeId: consumerEdge.nodeId, port: consumerEdge.port });
			}
		}

		// Delete the Gamma node and its incoming edges from the graph
		graph.removeNode(node);
		return true; // Graph was modified!
	}

	return false;
}

function getStructuralKey(node: Node): string {
	let key = node.type;
	// !== undefined, not a truthy check: a literal's own value is frequently falsy (0, false,
	// '', null) and still a real, distinct value -- a truthy check collapsed literal(0),
	// literal(false), literal(''), literal(null), and a valueless node all onto the SAME key
	// (found the hard way: literal(0) and a function's own synthetic literal(undefined) merged,
	// producing a spurious extra `return 0;` after the real, always-taken early return).
	if (node.value !== undefined) {
		switch (node.type) {
			case 'binary':
			case 'unary': key += (node.value as any).operator;
				break;
			// `obj.prop` and `obj?.prop` are structurally different expressions -- merging them would
			// silently drop the short-circuit, same failure mode `optional`'s own field comment
			// documents for reconstruction.
			case 'member': key += node.value + (node.optional ? '?' : '');
				break;
			// JSON.stringify, not a bare `+=`: the SAME falsy-collision class the `!== undefined`
			// gate above already fixed once survives here for the empty string specifically --
			// `key += ''` appends nothing, so literal('') produced the exact same key as a genuinely
			// valueless node (indistinguishable from literal(undefined)) and got silently CSE-merged
			// with one -- found on real code (binary-libs/src/pe.ts): a ternary's own `: ''` alternate
			// printed as `: undefined` after merging with an unrelated function's synthetic
			// fall-off-the-end literal(undefined). Stringifying unambiguously distinguishes every
			// value (including '', 0, false, null) from "no value at all" and from each other.
			default: key += JSON.stringify(node.value);
		}
	}

	return key + ':' + node.inputs.map(e => e ? `${e.nodeId}:${e.port}` : '').join(',');
}

export function optimizeStructuralCSE(graph: VSDG, protectedIds: Set<NodeId>): boolean {
	let anyChanges = false;

	// Maps a structural string signature back to the first Node that computed it
	const structuralTable = new Map<string, Node>();

	for (const node of graph.values()) {
		// Skip nodes with side-effects or loop/branch control flow tokens.
		// These are sequence-dependent and cannot be collapsed based purely on data inputs.
		// 'this'/'super' are ALSO unsafe despite having no inputs at all (found the hard way,
		// testing against a real multi-method class): every occurrence gets an identical
		// structural key ('this:'/'super:', no operands to distinguish them by), but each one's
		// real value is bound per CALL, not shared across the whole graph -- merging `this` from
		// one method with `this` from a completely different method conflates two different
		// receivers into one shared variable, corrupting both.
		// 'array'/'object' are unsafe for a DIFFERENT reason -- found the hard way on real code
		// (binary-libs/src/pe.ts, two `[]` literals in two completely separate functions, each
		// EXPECTED to start fresh on every call): unlike a real literal (`5`, `"x"`), `[]`/`{}`
		// create a NEW, DISTINCT object identity on every evaluation in real JS. Merging two
		// structurally-identical ones collapses that into ONE shared, persistent instance --
		// mutating it in one place (`result.push(...)`) leaks into every other site that reads
		// the "same" literal, across calls and even across unrelated functions.
		if (['mu', 'muValue', 'theta', 'thetaValue', 'gamma', 'gammaValue', 'effect', 'this', 'super', 'array', 'object'].includes(node.type))
			continue;

		// Generate the unique structural signature for this node
		const key = getStructuralKey(node);

		// Check if an identical calculation has already been recorded
		const masterNode = structuralTable.get(key);

		// A protected node (some out-of-band NodeId field still points at it -- see
		// collectProtectedNodeIds's own comment) must never be the one removed: merging IT away
		// would leave that field dangling. Left unregistered in structuralTable too (not just
		// skipped), so it stays its own, separate, un-mergeable node rather than silently
		// becoming a future duplicate's "master" via a table entry nothing here actually created.
		if (masterNode && masterNode.id !== node.id && protectedIds.has(node.id))
			continue;

		if (masterNode && masterNode.id !== node.id) {
			// Found a duplicate! We must merge 'node' into 'masterNode'.

			// 1. Redirect every downstream consumer reading from 'node'
			node.outputs.forEach((subscribers, outputPort) => {
				for (const consumerEdge of subscribers) {
					const consumerNode = graph.getNode(consumerEdge.nodeId)!;

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

// GCM

type BlockId = string;

// Discovers the program's branch/loop structure -- purely from control anchors (mu, theta, gamma,
// break_scope, except, effect) and each one's own state predecessor -- with NO involvement from
// ordinary value nodes at all. This is deterministic: it doesn't decide where anything reused or
// floating gets placed (that's applyGlobalCodeMotion's own job, layered on top), it just answers
// "where are the branches and loops, and how do they nest." Split out from applyGlobalCodeMotion
// so the block/loop structure is available as a standalone artifact -- e.g. for inspecting a
// program's control shape without needing a full GCM scheduling pass at all.
function buildBlockTree(graph: Map<NodeId, Node>) {
	// 1. Discover control anchors (mu, gamma, effect) and build 'rootBlocks'.
	// BuildVSDG's PROGRAM_START seed node (the whole program's state root) gets the well-known id
	// 'block_entry' directly, rather than an auto-numbered one like every other anchor -- Output's
	// own buildProgram needs a fixed, known starting point to begin its traversal from.
	const rootBlocks = new Map<NodeId, BlockId>();
	let blockCounter = 0;
	for (const [id, node] of graph.entries()) {
		if (node.type === 'effect' && node.value === 'PROGRAM_START') {
			rootBlocks.set(id, 'block_entry');
		} else if (node.type === 'effect') {
			// effect (call) nodes have hard sequential side-effects and a real state edge at inputs[0].
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		} else if (node.type === 'gamma' || node.type === 'mu' || node.type === 'theta' || node.type === 'break_scope') {
			// gamma/mu/theta each have their own dedicated type tag now, distinct from the
			// per-variable gammaValue/muValue/thetaValue -- so, unlike except below, no typeof-value
			// check is needed here to tell them apart: a node literally tagged 'gamma'/'mu'/'theta'
			// is always the real state/control anchor (its inputs[0] is genuinely a state-chain
			// predecessor), full stop. This used to be the exact bug class found and fixed the hard
			// way for gamma (see neverMaterialize's own comment) and would have hit theta too --
			// thetaValue's own port 0 is its CONDITION operand, not a state predecessor at all,
			// unlike the real state theta's port 0 (see buildLoop's own port comments) -- so a
			// unified 'theta' tag relying on typeof-value here would have mis-scheduled a thetaValue
			// exactly the same way. break_scope has no per-variable analog at all (there's no "break
			// exits this" equivalent for a single value).
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		} else if (node.type === 'except' && typeof node.value !== 'string') {
			// except still shares one type tag between its state and NAMED (per-variable) forms --
			// see BuildVSDG's 'try' case, which builds a real `makeNode('except', name)` directly
			// (not through reconcileVariables/gammaValue) -- so the typeof check still matters here.
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		} else if (node.type === 'function_decl' || node.type === 'passthru' || node.type === 'class_decl') {
			// A declaration statement, threaded sequentially into the state chain exactly like an
			// effect (see BuildVSDG's own cases) -- needs its own block for the same reason every other
			// state-chain link does: emitFrom's traversal only ever visits rootBlocks-anchored nodes.
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		}
	}

	// The reverse of rootBlocks: which node anchors a given block. Built once here (rather than
	// separately, later, in the final packing step) so getLoopDepth can look up a block's REAL node
	// type directly, instead of guessing it from the block id's string prefix.
	const blockControl = new Map<BlockId, NodeId>();
	for (const [nodeId, blockId] of rootBlocks)
		blockControl.set(blockId, nodeId);

	// Maps a Block ID to its immediate parent Block ID in the Dominator Tree
	const blockTree = new Map<BlockId, BlockId>();

	// The entry block has no parent -- deliberately left unset (not a self-loop) so that every
	// walk-to-root loop below (`for (...; current; current = blockTree.get(current))`) terminates
	// when it reaches 'block_entry'; a self-loop here made blockTree.get('block_entry') always
	// truthy, so any such walk that reached it spun forever.

	for (const [nodeId, blockId] of rootBlocks.entries()) {
		if (!blockId)
			continue;

		// Port 0 is the real state predecessor for every control-anchor type by construction (effect,
		// state-gamma, state-theta, and state-mu all put it there) -- see their creation sites in
		// BuildVSDG for why this wasn't always true before they were reordered to be consistent.
		const incomingStateEdge = graph.get(nodeId)?.inputs[0];
		if (incomingStateEdge)
			// Find which block contains the node that produced our incoming state token
			blockTree.set(blockId, rootBlocks.get(incomingStateEdge.nodeId) ?? '');
	}

	// How many loops actually enclose a block, computed from real node types and blockTree ancestry
	// -- not (as before) a guess based on whether the block id's string happens to start with "mu".
	// The relation: a state-mu's own block is one deeper than its blockTree parent (entering the
	// loop); a state-theta's block is the EXIT of its own mu -- despite being a blockTree-descendant
	// of it (the theta's real predecessor IS that mu), it runs once, after the loop, so its depth is
	// whatever the loop's OWN parent had, not one more than it; every other block just inherits its
	// parent's depth unchanged. This correctly generalizes to nested loops, since each mu/theta pair
	// only ever adjusts depth relative to its own immediate parent.
	const loopDepthMemo = new Map<BlockId, number>();
	function getLoopDepth(blockId?: BlockId): number {
		if (blockId === undefined)
			return 0;
		const cached = loopDepthMemo.get(blockId);
		if (cached !== undefined)
			return cached;
		loopDepthMemo.set(blockId, 0); // defensive cycle guard; block_entry has no parent, so real cycles shouldn't occur
		const parentId		= blockTree.get(blockId);
		const parentDepth	= getLoopDepth(parentId);
		const node			= blockControl.has(blockId) ? graph.get(blockControl.get(blockId)!) : undefined;

		let depth = parentDepth;
		if (node?.type === 'mu') {
			depth = parentDepth + 1;
		} else if (node?.type === 'theta') {
			const muBlockId		= rootBlocks.get(node.inputs[0].nodeId); // the state-theta's own mu
			const muParentId	= muBlockId !== undefined ? blockTree.get(muBlockId) : undefined;
			depth = getLoopDepth(muParentId);
		}
		loopDepthMemo.set(blockId, depth);
		return depth;
	}

	return { rootBlocks, blockControl, blockTree, getLoopDepth };
}

export function applyGlobalCodeMotion(graph: Map<NodeId, Node>) {
	const blockIds = new Map<NodeId, BlockId>();
	const { rootBlocks, blockControl, blockTree, getLoopDepth } = buildBlockTree(graph);

	// Which function's own region a block belongs to -- walks blockTree up until hitting either
	// 'block_entry' (the top-level program) or a function's own FUNCTION_BODY_START marker,
	// memoized since scheduleLate calls this once per consumer edge. Deliberately NOT the
	// function_decl node's own block: that's reachable from BOTH the function's own body AND
	// whatever textually follows the declaration (entryNode's port-0 output has two logically
	// different consumers -- see FUNCTION_BODY_START's own comment, in BuildVSDG), so blockTree
	// ancestry alone can't tell "genuinely inside this function" apart from "next, outside it".
	// The dedicated start marker is what actually disambiguates: only the body threads from IT.
	const regionRootMemo = new Map<BlockId, BlockId>();
	function regionRootOf(blockId: BlockId): BlockId {
		const cached = regionRootMemo.get(blockId);
		if (cached !== undefined)
			return cached;
		const control = blockId !== 'block_entry' ? graph.get(blockControl.get(blockId)!) : undefined;
		let root = blockId;
		if (blockId !== 'block_entry' && !(control?.type === 'effect' && control.value === 'FUNCTION_BODY_START')) {
			const parent = blockTree.get(blockId);
			root = parent !== undefined ? regionRootOf(parent) : blockId;
		}
		regionRootMemo.set(blockId, root);
		return root;
	}

	// A function_decl's own block is deliberately ambiguous for regionRootOf (see its own comment
	// just above) -- but a PARAM reading that function_decl node directly is never one of the two
	// ambiguous cases at all: it's unconditionally inside the function, regardless of blockId
	// sharing. Params read the function_decl node at ports >= 1 (port 0 is reserved for the state
	// chain -- see BuildVSDG's buildFunctionBody, "port 0 = State, so params occupy port index+1"),
	// so scheduleEarly uses THIS instead of the function_decl's own block whenever it follows one
	// of those edges -- otherwise a value derived only from params (e.g. a CSE-shared `a * b`) gets
	// its own earliestBlock pinned at the function_decl's block, which regionRootOf resolves to
	// block_entry, excluding it from every real in-function consumer's own scheduleLate constraint
	// and stranding it outside the function -- referencing parameters that don't exist there.
	const functionBodyBlockMemo = new Map<NodeId, BlockId>();
	function functionBodyBlockOf(functionDeclId: NodeId): BlockId {
		const cached = functionBodyBlockMemo.get(functionDeclId);
		if (cached !== undefined)
			return cached;
		const bodyStart = (graph.get(functionDeclId)!.outputs[0] ?? [])
			.map(e => graph.get(e.nodeId)!)
			.find(n => n.type === 'effect' && n.value === 'FUNCTION_BODY_START');
		const block = (bodyStart && rootBlocks.get(bodyStart.id)) ?? rootBlocks.get(functionDeclId)!;
		functionBodyBlockMemo.set(functionDeclId, block);
		return block;
	}

	// 2. Phase 1: Push everything as early as possible
	const visitedEarly = new Set<NodeId>();

	function scheduleEarly(nodeId: NodeId) {
		if (visitedEarly.has(nodeId))
			return;
		visitedEarly.add(nodeId);


		// Fixed anchoring nodes (control-flow or side effects) are pinned to their own blocks
		if (rootBlocks.has(nodeId)) {
			blockIds.set(nodeId, rootBlocks.get(nodeId)!);
			return;
		}

		const node = graph.get(nodeId)!;// as NodeWithBlock;

		// Default to the first entry block of the program -- unless this is a 'this'/'super' node
		// (or anything else ever stamped with scopeAnchorId), which has NO input edges at all to
		// otherwise floor it against its own function (see scopeAnchorId's own comment, and
		// functionBodyBlockOf's).
		let earliestBlock = node.scopeAnchorId !== undefined ? functionBodyBlockOf(node.scopeAnchorId) : "block_entry";

		// Recursively process all input dependencies first
		node.inputs.forEach((edge, port) => {
			if (!edge)
				return;
			// A mu's port 1 is its FEEDBACK edge -- a genuine back-edge (that's what makes it a loop):
			// the loop body's own reassignment depends on the mu, and the mu's feedback depends right
			// back on that reassignment. Recursing into it here would chase that cycle; memoization
			// (visitedEarly) stops it from crashing, but whichever side gets visited first ends up
			// computed WITHOUT the other's depth (blockIds isn't set for it yet), silently landing too
			// shallow. The mu's own earliest position never needs this edge anyway -- only its initial
			// value (port 0) and its scheduling-anchor edge, if any, ever determine that.
			if ((node.type === 'mu' || node.type === 'muValue') && port === 1)
				return;
			// A muValue's port 2 ties it to its owning mu's own block unconditionally -- correct
			// for a genuinely loop-carried variable (it can't be computed before the loop it's
			// carried by even exists), but wrong for one that's never actually reassigned in this
			// loop at all: its own port-1 feedback is then just a trivial self-loop
			// (node.inputs[1].nodeId === nodeId), proving it's loop-invariant, so nothing about
			// this loop should floor its placement -- only its real value-producing edges (port 0,
			// the initial/only value) should. Loop-invariant hoisting falls out of this for free:
			// scheduleEarly already computes "as early as legal", so skipping this one floor lets
			// it land wherever its own (non-loop-carried) inputs actually require.
			if (node.type === 'muValue' && port === 2 && node.inputs[1]?.nodeId === nodeId)
				return;
			scheduleEarly(edge.nodeId);
			// The current node must be scheduled AFTER its inputs are ready.
			// We find the deepest block among all inputs. A param edge (see functionBodyBlockOf's
			// own comment) uses the function's own body block instead of the function_decl's own
			// (edge.port is the PRODUCER's own output port here -- port 0 is reserved for the state
			// chain, so port !== 0 into a function-entry node is unambiguously a param read).
			// Checked via `returnNodeId` (stamped unconditionally by buildFunctionBody, never
			// cleared), not `.type === 'function_decl'`: an arrow/function EXPRESSION's own entry
			// node has its `.type` overwritten to 'effect' right after buildFunctionBody returns
			// (see BuildVSDG's 'arrow'/'function' case), so the type check alone silently never
			// matched a param read inside one -- an arrow's own param-derived, GCM-hoisted pure
			// value could float all the way out of the arrow entirely, past its own parameter's
			// scope (found via a real ReferenceError on real code: `v.address` hoisted out of a
			// `.map((v, i) => ...)` callback to the enclosing function's top level).
			const targetNode	= graph.get(edge.nodeId)!;
			const edgeBlock	= targetNode.returnNodeId !== undefined && edge.port !== 0
				? functionBodyBlockOf(edge.nodeId)
				: blockIds.get(edge.nodeId);
			if (edgeBlock !== undefined && isDeeperThan(blockTree, edgeBlock, earliestBlock))
				earliestBlock = edgeBlock;
		});

		blockIds.set(nodeId, earliestBlock);
	}

	for (const nodeId of graph.keys())
		scheduleEarly(nodeId);

	// 3. Phase 2: Pull things down to save execution costs
	const visitedLate = new Set<NodeId>();

	function scheduleLate(nodeId: NodeId) {
		if (visitedLate.has(nodeId))
			return;
		visitedLate.add(nodeId);


		// Pin fixed execution nodes
		if (rootBlocks.has(nodeId))
			return;

		const node = graph.get(nodeId)!;

		// Recursively process all downstream consumers first
		for (const portChannels of node.outputs) {
			if (!portChannels)
				continue;
			for (const consumerEdge of portChannels)
				scheduleLate(consumerEdge.nodeId);
		}

		// Find the Least Common Ancestor (LCA) block of all consumers
		let latestBlock: BlockId | null = null;

		for (const portChannels of node.outputs) {
			if (!portChannels)
				continue;
			for (const consumerEdge of portChannels) {
				const consumerNode = graph.get(consumerEdge.nodeId)!;

				// A mu's port 1 is its FEEDBACK edge -- "the value THIS read produces for the NEXT
				// iteration to see", a genuine back-edge (same cycle scheduleEarly already has to skip
				// for the same reason). It doesn't constrain "must be ready by" the mu's own block at
				// all -- treating it as an ordinary consumer could make latestBlock come out SHALLOWER
				// than earliestBlock (a contradiction: the mu itself is scheduled at the loop header,
				// but this node's own inputs might only be ready deeper inside the same iteration),
				// which the walk below has no way to reconcile since it only ever walks upward.
				if ((consumerNode.type === 'mu' || consumerNode.type === 'muValue') && consumerEdge.port === 1)
					continue;

				// The exact same structural issue, for if/else: feeding a gammaValue's trueVal (port 1)
				// or falseVal (port 2) only means "I'm one of the two alternatives this ternary picks
				// between", not "I must be ready by the gammaValue's own block" -- that block sits
				// AFTER both branches, not inside either one, so treating this as an ordinary consumer
				// could produce a latestBlock that isn't even a blockTree descendant of earliestBlock
				// (the branch's own content is a SIBLING of the post-if continuation, not its
				// ancestor), which the walk below has no way to reconcile either.
				if (consumerNode.type === 'gammaValue' && consumerEdge.port !== 0)
					continue;

				// The exact same structural issue again, for a NAMED except's own tryVal (port 0) or
				// catchVal (port 1): unlike a named gamma, except has no condition port at all (both
				// ports are "value" ports), so BOTH are excluded here, with no `!== 0` exception.
				if (consumerNode.type === 'except' && typeof consumerNode.value === 'string')
					continue;

				// The exact same structural issue again, for the state theta's own port-1
				// (condition): the theta's own block represents "after the loop has exited" --
				// logically outside it -- but the condition it reads is physically computed and
				// re-evaluated INSIDE the loop, every iteration. Treating this as an ordinary "must
				// be ready by the theta's own (post-loop) block" constraint pulls a value feeding
				// ONLY the loop test's own condition to be scheduled as if it belonged outside the
				// loop entirely -- one loop-nesting level shallower than everything else it's also
				// consumed by inside the loop (e.g. a body-computed reassignment the test reads
				// directly, only possible for `do...while`, whose test runs after the body -- a
				// `while` loop's test never reads a body-computed value, so this never surfaced
				// there). getLoopDepth then reports the SAME depth for the theta's own (post-loop)
				// block as for blocks genuinely inside the loop (both count as "0 loops enclosing
				// depth-wise" from the theta's adjusted perspective), so the walk's floor check
				// can't tell them apart either -- it silently accepts the shallower, wrong block
				// instead of ever reaching the real, deeper floor (which the walk, going only
				// upward from a too-shallow latestBlock, can never even reach).
				if (consumerNode.type === 'theta' && consumerEdge.port === 1)
					continue;

				// Likewise never actually read by codegen -- left as an ordinary constraint, this
				// dragged the OLD value's own declaration/scheduling into wherever the assignment
				// itself happened to live (e.g. into an if-branch it has no real reason to be inside).
				if (consumerNode.isVestigialEdge(consumerEdge.port))
					continue;

				let consumerBlock = blockIds.get(consumerEdge.nodeId)!;

				// Special case: feeding a mu's port 0 (its INITIAL, pre-loop value -- e.g. `let i = 0;` feeding i's mu) belongs to the block *before* the loop, not wherever the mu itself now lives.
				// The pre-header is the immediate dominator sitting right outside the loop structure.
				if ((consumerNode.type === 'mu' || consumerNode.type === 'muValue') && consumerEdge.port === 0)
					consumerBlock = blockTree.get(consumerBlock) || "block_entry";

				// A consumer belonging to a DIFFERENT function's own region (see regionRootOf) isn't
				// "must be ready by this consumer's block" the way an ordinary same-region consumer
				// is -- it's an edge crossing a function's own call boundary (e.g. a captured
				// variable's reassignment, later read by name after the function returns -- see
				// BuildVSDG's 'binary' case). That consumer might run zero, one, or many times, at a
				// point this static schedule has no way to place relative to this node's own
				// position, so treating it as an ordinary constraint would (and did, empirically)
				// drag the node out of the function it structurally belongs in, to sit wherever the
				// consumer's own shallow, outer block happens to be. forcedPrint (see the same
				// 'binary' case) is what keeps such a node from being silently dropped once its only
				// consumer is excluded here -- this only controls WHERE it's scheduled, not whether
				// it still needs to print.
				if (regionRootOf(consumerBlock) !== regionRootOf(blockIds.get(nodeId)!))
					continue;

				latestBlock = latestBlock === null
					? consumerBlock
					: findLeastCommonAncestor(blockTree, latestBlock, consumerBlock);
			}
		}

		// Click's Core Sinking Choice:
		// Walk from the latest possible block up to the earliest possible block, picking the
		// SHALLOWEST valid block along the way (lowest execution frequency, e.g. outside loops) --
		// "valid" meaning never shallower than earliestBlock's OWN depth (the floor). earliestBlock
		// already encodes the deepest position this node's inputs actually require (e.g. depth 1
		// because it reads a per-iteration mu value); going shallower than that would place the node
		// somewhere its own dependencies aren't validly computable (e.g. hoisted past the loop that
		// makes a mu-provided value meaningful).
		//
		// Ties matter: getLoopDepth only counts LOOP nesting, so it reports the SAME depth for every
		// block within one loop iteration (or one un-looped chain) even though they're still
		// meaningfully different positions. When two candidates tie, prefer whichever is closer to
		// latestBlock (found EARLIER in this walk), not earliestBlock -- otherwise a node whose sole
		// consumer lives right next to it (same depth, later in the chain) gets needlessly hoisted
		// all the way back to its earliest position, landing in a DIFFERENT block than the consumer
		// that needs it, which breaks emitLocalStatements' single-block topological sort entirely.
		//
		// KNOWN GAP, deliberately NOT fixed here (tried and reverted -- see the tracked plan): two
		// adjacent, same-depth declarations that are each other's own dedicated anchor (`let i = off,
		// e = i + len;`) can have this tie-break pick the WRONG one of the two, swapping their
		// printed order (`let e = i + len; let i = off;`, reading `i` before its own declaration --
		// found testing real code). A version that preferred a node's own port-2 anchor on a tie
		// fixed that case but broke dead-bookkeeping elision elsewhere (a switch's own unused
		// `__hit`/`__match` scaffolding, normally sunk out of anything ever visited by THIS exact
		// same "prefer closer to latest" choice, started printing instead) -- the two cases are
		// genuinely indistinguishable from information available at this point in scheduling.
		const earliestBlock	= blockIds.get(nodeId)!;
		const floor			= getLoopDepth(earliestBlock);
		let bestBlock: BlockId | undefined;
		let bestDepth		= Infinity;

		// The `currentBlock` guard (not just `!== earliestBlock`) is a defensive backstop: if blockTree
		// ever has a dead end that doesn't actually pass through earliestBlock on the way to the root,
		// this stops instead of wandering into `undefined` and spinning forever.
		let currentBlock: BlockId | undefined = latestBlock || earliestBlock;
		while (currentBlock !== undefined) {
			const depth = getLoopDepth(currentBlock);
			if (depth >= floor && depth < bestDepth) {
				bestDepth = depth;
				bestBlock = currentBlock;
			}
			// earliestBlock (depth === floor) is always a valid candidate and is included in this
			// walk, guaranteeing bestBlock ends up set -- so stop right after considering it.
			currentBlock = currentBlock === earliestBlock ? undefined : blockTree.get(currentBlock);
		}

		blockIds.set(nodeId, bestBlock!);
	}
	for (const nodeId of graph.keys())
		scheduleLate(nodeId);

	return { blockIds, blockControl, getLoopDepth };
}

// Wraps a reconstructed statement in `export `/`export default `, per a node's own `exported`
// stamp (see the Node field's own comment) -- shared by 'passthru' and 'function_decl' printing,
// the two node types `export`/`export_decl` can currently leave behind.
function wrapExported(stmt: Statement, exported: 'named' | 'default' | undefined): Statement {
	return exported === 'named' ? { type: 'export_decl', declaration: stmt } as Statement
		: exported === 'default' ? { type: 'export', default: stmt } as Statement
		: stmt;
}

