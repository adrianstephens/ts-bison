import * as JS from './js-parser';
import * as TS from './ts-parser';
import { Identifier, Literal } from '../common';
import { Walkable, walkB, calcUnary, calcBinary, RecurseB } from './walker';

const ASSIGN_OPS	= new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);
type Expr			= TS.Expr;
type Statement		= TS.Statement;

// VSDG

type NodeId = string;

interface Edge {
	nodeId:	NodeId;
	port:	number; 
}

class Node {
	inputs:		Edge[]		= [];	// inputs[port] = The single specific source edge feeding this slot
	outputs:	Edge[][]	= [];	// outputs[port] = An array of ALL downstream edges consuming this specific channel
	// Set when this node's result is the current binding of a real source-level variable (a var_decl,
	// a plain reassignment, or a ++/-- target) -- tells Output to print it under that name (declaring
	// it once via `declKind`, then a plain reassignment) instead of an anonymous `const tN = ...` temp.
	boundName?:	string;
	declKind?:	JS.DeclarationKind;
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
	// anything but a do-while's own state mu). Read only by blocksToAST, to pick which shape to
	// reconstruct: `do { body } while (test);` needs no loop-rotation trick at all (the body
	// already runs before the test, unlike `while`, so there's nothing to rotate).
	loopKind?: 'do';
	// The catch clause's own binding name (e.g. 'e'), stamped on the STATE `except` anchor for
	// blocksToAST to reconstruct `catch (e) {...}` with. Can't reuse `.value` here either, for the
	// exact same reason as `loopKind` above -- it's what distinguishes a NAMED (per-variable)
	// except from the unnamed state one.
	catchParam?: string;
	// A function_decl/class_decl's own RETURN_ANCHOR node id, stamped on the entry node so
	// blocksToAST's function_decl reconstruction can find it -- there's no ordinary graph edge from
	// entry to return (the only edge is FINAL STATE -> return, discovered by walking the body's own
	// chain backward, which for an EMPTY body coincides with entry itself and so can't be told apart
	// from "there is no return node" by edge-walking alone).
	returnNodeId?: NodeId;
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
		// A state gamma's true/false-tail ports (2/3) are structural only: blocksToAST reads
		// `control.inputs[2]/[3]` directly (via branchEntryBlock) to find where each branch's content
		// starts, never through resolveOperand -- so a call that happens to be the last effect in its
		// branch is never actually "read" for its VALUE just by virtue of being that branch's tail.
		if (this.type === 'gamma' && (port === 2 || port === 3))
			return true;
		// A break_scope's own tail port (1): same reasoning as a gamma's tail ports -- blocksToAST
		// reads it directly (via branchEntryBlock) to find where the scope's wrapped content
		// starts, never through resolveOperand.
		if (this.type === 'break_scope' && port === 1)
			return true;
		// A state-merging (unnamed) except's try/catch/finally tails (1/2/3): same reasoning as a
		// state-gamma's own tail ports -- blocksToAST finds each part's content via
		// branchEntryBlock, never through resolveOperand. Unlike gamma, a NAMED except's own value
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
}

class ScopeMu extends Scope {
	muNodes = new Map<string, Node>();

	// `stateAnchor` (the loop's real state-mu) is only used for a scheduling-only edge below -- a
	// named per-variable mu isn't itself a rootBlock anchor (its inputs[0] is an initial VALUE, not
	// state), so without some real dependency pulling it deeper than the pre-loop block, GCM would
	// happily schedule anything that depends on it (e.g. the loop body's own reassignment) as if it
	// were loop-invariant and float it out before the loop entirely.
	constructor(parent: Scope, public makeNode: (type: string, varName: string) => Node, public stateAnchor: Node) {
		super(parent);
	}
	public get(name: string): Node | undefined {
		const node = this.bindings.get(name);
		if (node)
			return node;
		const old = this.parent?.get(name);
		if (old) {
			const mu = this.makeNode('muValue', name);
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

	optimize(): void {
		let changed = true;

		while (changed) {
			changed = false;

			for (const node of this.values()) {
				// 1. Try to fold constant math operations
				if (foldConstants(this, node))
					changed = true;

				// 2. Try to eliminate dead if/else branches
				if (foldDeadBranches(this, node))
					changed = true;
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
	// wrapper at all, which is what applyGlobalCodeMotion/blocksToAST currently assume -- has nothing
	// valid to thread its first state edge from.
	let end: Node = makeNode('effect', 'PROGRAM_START');

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
			if (found)
				return found;
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
		connectValue(end, 0, marker, 0);
		connectValue(marker, 0, node, 2);
		end = marker;
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
		const muScope	= new ScopeMu(scope, makeNode, muEnd);
		connectValue(end, 0, muEnd, 0); // Slot 0 = Initial value from outside
		scope	= muScope;
		end		= muEnd;

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
	function mergeState(parent: State, test: Node, trueState: State, falseState: State) {
		if (trueState.exited || falseState.exited || hasRealEffect(trueState.end, parent.end) || hasRealEffect(falseState.end, parent.end)) {
			const gamma = makeNode('gamma');
			connectValue(parent.end, 0, gamma, 0);		// Slot 0 = State predecessor
			connectValue(test, 0, gamma, 1);				// Slot 1 = Condition
			connectValue(trueState.end, 0, gamma, 2);		// Slot 2 = True State
			connectValue(falseState.end, 0, gamma, 3);	// Slot 3 = False State
			end = gamma;
		} else {
			// No real effect in either branch: the reassignment(s), if any, are already fully
			// captured by reconcileVariables's own per-variable named gamma (a pure ternary needs no
			// structural if/else). `end` must still be reset -- left alone, it would dangle off
			// whichever branch's mutation-marker chain was walked last, instead of the state that
			// actually continues past this (structurally absent) branch.
			end = parent.end;
		}
		// This branch pair only counts as "exited" (to whatever encloses it) when BOTH sides did --
		// an implicit empty else (or, for a switch case, simply not matching) always falls through,
		// so the non-existent side's own state already correctly reports exited: false.
		exited = trueState.exited && falseState.exited;
		// Propagated the same way: only true when BOTH sides exited AND both did so via break (mixed
		// kinds -- e.g. one side breaks, the other returns -- fall back to false here, same as
		// reconcileVariables's own "both exited" case: nothing downstream is reachable from EITHER
		// path there anyway, so which value it "would" merge to is moot).
		brokeOut = exited && trueState.brokeOut && falseState.brokeOut;
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

				if (trueExitedViaBreak && trueVal.boundName === name)
					trueVal.forcedPrint = true;
				else if (trueVal.boundName === name && !trueVal.declKind)
					trueVal.boundName = undefined;

				if (falseExitedViaBreak && falseVal.boundName === name)
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

	walkB(ast,
		(s, process, recurse) => {
			switch (s.type) {
				case 'function_decl': {
					const outer = getState();

					// 1. Establish the internal localized graph builder context

					// 2. Instantiate the Function Boundary Nodes
					const entryNode		= makeNode('function_decl', s);
					const returnNode	= makeNode('effect', 'RETURN_ANCHOR');
					entryNode.returnNodeId = returnNode.id;
					// Anchor the DECLARATION's own position in the OUTER state chain -- same as any
					// ordinary sequential statement (real hoisting semantics aren't modeled; this pass
					// never reorders anyway, so "declared at this point, in this order" is always safe).
					// Without this it's an unanchored island: nothing ever schedules or visits it, so it
					// silently never gets printed (its own outputs are never a real value edge either --
					// see buildEffectExpr's call/new handling for why a callee is never resolved through
					// the graph -- so scheduleLate would never place it anywhere on its own).
					connectValue(outer.end, 0, entryNode, 0);

					// 3. Seed an isolated local scope for the function body
					// This isolates function variables completely from the outer global scope
					const fnScope = new Scope(scope);

					// Wire incoming output ports from the entry node directly to parameter bindings.
					// Each param gets its own node (port 0 = State, so params occupy port index + 1);
					// without a dedicated node per param they'd all alias entryNode's port 0.
					s.params.forEach((p, index) => {
						if (typeof p.key === 'string') {
							const paramNode = makeNode('var', p.key);
							connectValue(entryNode, index + 1, paramNode, 0);
							fnScope.create(p.key, paramNode);
						} else {
							console.log(`not handling destructured parameter`);
						}
					});

					// 4. Temporarily swap the master compiler pointers into the function's region

					setState(fnScope, entryNode); // The sequential state chain inside the function hangs off the entry node

					// 5. Recursively walk and generate the entire function body statements block
					process(s);

					// 6. Connect the final sequential execution state to the return anchor
					connectValue(end, 0, returnNode, 0); // Slot 0 = Final State

					// 7. returnNode's own port 1 is left otherwise unused: every explicit `return`
					// (early or not) now prints itself in place, via its own EARLY_RETURN_MARKER --
					// see emitLocalStatements -- so there's no real value left to reconcile HERE.
					// A synthetic `undefined` keeps the port populated for GCM/blocksToAST's own
					// "is there really a value here" check (see emitFrom's function_decl case).
					connectValue(makeNode('literal', undefined), 0, returnNode, 1); // Slot 1 = Return Value

					// 8. Restore the master compiler pointers back to the global file scope
					// `entryNode`, not `outer.end` -- it's now part of the sequential chain (see the
					// connectValue above), so whatever textually follows must chain from IT, not skip
					// past it back to where the chain was before this declaration.
					setState(outer.scope, entryNode, outer.exited, outer.brokeOut);
					return false;
				}

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
					connectValue(end, 0, marker, 0);
					if (s.argument)
						connectValue(getExprNode(s.argument), 0, marker, 1);
					end = marker;
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
					const argNode = getExprNode(s.argument);
					const marker = makeNode('effect', 'THROW_MARKER');
					connectValue(end, 0, marker, 0);
					connectValue(argNode, 0, marker, 1);
					end = marker;
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
					// blocksToAST prints a literal `break;` here. The printed statement itself is what
					// real JS routes to the nearest enclosing loop/switch at runtime.
					const marker = makeNode('effect', 'BREAK_MARKER');
					connectValue(end, 0, marker, 0);
					end = marker;
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
					const marker = makeNode('effect', 'CONTINUE_MARKER');
					connectValue(end, 0, marker, 0);
					end = marker;
					exited = true;
					return false;
				}
				case 'var_decl': {
					process(s);
					for (const v of s.declarations) {
						if (typeof v.name === 'string') {
							// A dedicated wrapper node per declared variable, rather than aliasing directly
							// to the initializer's node: without it, `let x = 5; let y = 5;` would bind BOTH
							// names to the very same literal node (or, worse, to whatever a later CSE pass
							// merges it with), so codegen would have no way to tell which name to print, and
							// Output never had a declaration statement to emit for a local in the first place.
							const varNode = makeNode('var', v.name);
							if (v.init)
								connectValue(getExprNode(v.init), 0, varNode, 0);
							varNode.declKind = s.kind;
							// A declaration is an observable event too, same as a reassignment: `resolveNode`
							// prints ANY 'var' node as a bare `Identifier(name)` unconditionally (it has to --
							// that's also how parameters, which really do pre-exist, are read), so nothing
							// about reading it enforces "the declaration was already emitted". Without this,
							// GCM was free to schedule `let a = 1;`'s own statement AFTER code that already
							// reads `a` (e.g. an `if (a)` test right after it), since both just look like
							// ordinary data to the scheduler.
							rebindVar(v.name, varNode, true);
						} else {
							console.log(`not handling destructured declarator`);
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
					// `for...in`/`for...of` are a separate, much bigger feature (iterator protocol,
					// destructuring targets) -- not attempted here.
					if (s.kind !== 'normal') {
						console.log(`not handling for-${s.kind}`);
						return process(s);
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
					const discNode = makeNode('var');
					connectValue(discValue, 0, discNode, 0);
					discNode.declKind = 'let';
					const suffix = discNode.id;
					const discName = `__disc_${suffix}`;
					discNode.value = discName;
					// rebindVar (not a bare scope.create) matters here: it's what threads discNode
					// into the state chain via threadMutation. Without it, discNode is never
					// scheduled anywhere blocksToAST's traversal reaches -- `let __disc = ...;`
					// silently never gets printed even though every case test still reads its name.
					rebindVar(discName, discNode, true);

					// Each case's own test is evaluated EXACTLY ONCE, in source order (real switch
					// semantics: a test with a side effect, e.g. `case f():`, runs once each, in
					// order -- reusing the same expression object a second time, to compute
					// `default`'s condition below, would re-walk and re-run it). Captured into its
					// own named boolean so nothing else ever needs to read the comparison twice.
					const matchNames = s.cases.map((c, i) => {
						if (!c.test)
							return undefined;
						const matchName = `__match${i}_${suffix}`;
						recurse(JS.VarDecl('let', JS.Var(matchName,
							{ type: 'binary', operator: '===', left: Identifier(discName), right: c.test } as Expr
						)));
						return matchName;
					});

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
					const hasCases = s.cases.length > 0;

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
					if (hasCases) {
						// The anchor is created AFTER walking the cases, not before -- exactly like
						// a gamma's own predecessor/tail split. Creating it first (and setting `end`
						// to it before walking) would make the first case's own `parent.end` BE the
						// anchor itself, so branchEntryBlock's backward walk (in blocksToAST) would
						// hit the anchor's own block on its very first step, before ever reaching the
						// real predecessor -- returning the anchor's own (already-being-emitted) block
						// as "the content's entry", which prints as empty.
						//
						// A dedicated start marker sits BETWEEN the real predecessor and the cases'
						// own walk, rather than letting them share `predecessor` directly: the first
						// case, if it needs a real state-gamma of its own (e.g. it contains a break),
						// would otherwise have that gamma share the EXACT SAME predecessor node as
						// break_scope itself -- two "preferred" (gamma/mu/break_scope) targets
						// competing for the one port-0 edge successorBlock uses to find "what comes
						// next" from that shared predecessor, with no way to tell them apart. The start
						// marker is a plain 'effect' (not a preferred type), so it can't collide.
						const predecessor = end;
						const startMarker = makeNode('effect', 'BREAK_SCOPE_START');
						connectValue(predecessor, 0, startMarker, 0);
						end = startMarker;
						exited = false;
						brokeOut = false;

						for (const [i, c] of s.cases.entries()) {
							const testExpr = {
								type: 'binary', operator: '||',
								left: Identifier(hitName),
								right: matchNames[i] ? Identifier(matchNames[i]!) : negateOr(realMatches),
							} as Expr;
							recurse(testExpr, 'expression');
							const testNode	= getExprNode(testExpr);
							const parent	= getState();
							const trueState = walkBranch(parent, () => {
								// A real 'binary' '=' node (not a bare rebind to a fresh literal), so
								// it's eligible for the same isInlinableSlot elision as any ordinary
								// reassignment -- matches what the original synthetic `hit = true;`
								// AST fragment would have built by going through the same expression hook.
								recurse({ type: 'binary', operator: '=', left: Identifier(hitName), right: Literal(true) } as Expr, 'expression');
								for (const stmt of c.consequent)
									recurse(stmt, 'statement');
							});
							const falseState = walkBranch(parent, () => {});
							mergeState(parent, testNode, trueState, falseState);
							reconcileVariables(parent, testNode, trueState, falseState);
						}
						const tail = end;

						const breakScope = makeNode('break_scope');
						connectValue(predecessor, 0, breakScope, 0);
						// Port 1 = the scope's own tail (mirrors a gamma's true/false-tail ports): where
						// blocksToAST finds the wrapped content ends.
						connectValue(tail, 0, breakScope, 1);
						end = breakScope;
						exited = false;
						brokeOut = false;
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
					// compete with `except` itself for the shared predecessor's one port-0 edge, an
					// order-dependent ambiguity successorBlock has no way to resolve correctly.
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
					if (typeof s.handlerParam === 'string') {
						// Opaque and externally provided -- no input edge; there's no computation
						// inside `try` this could ever be resolved back to.
						const excValue = makeNode('var', s.handlerParam);
						scope.create(s.handlerParam, excValue);
					} else if (s.handlerParam) {
						console.log(`not handling destructured catch parameter`);
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
					if (typeof s.handlerParam === 'string')
						exc.catchParam = s.handlerParam;
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
					// since this reconstructs a REAL `finally` clause (see blocksToAST), real JS's
					// own semantics already guarantee that on their own, for every exit (including
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
						// Port 3 = finally's own tail (mirrors a gamma's true/false-tail ports):
						// where blocksToAST finds the wrapped content ends.
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

				default:	{
					// like function_decl above, for the same reason (an unreferenced declaration is otherwise an unanchored island nothing ever schedules or visits).
					process(s);
					const node = makeNode('passthru', s);
					connectValue(end, 0, node, 0);
					end = node;
					return false;
				}
			}
			return process(s);
		},
		(s, process) => {
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
				case 'this':
					// Unlike 'identifier', which getExprNode resolves via a dedicated scope lookup that
					// bypasses expnodes entirely, `this`/`super` have no such lookup -- they need a real
					// node registered here, or any consumer (`this.x`, `f(this)`, ...) throws "missing
					// node" trying to look one up that was never created.
					expnodes.set(s, makeNode(s.type));
					return false;

				case 'unary': {
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
						if (s.left.type === 'identifier')
							rebindVar(s.left.name, node);
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
					if (pure) {
						const node = makeExprNode(s);
						s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));

					} else {
						const node = makeExprNode(s, 'effect');
						connectValue(end, 0, node, 0); // Slot 0 = Input State
						// Update the current state pointer to this new call
						end = node;

						// 2. Thread Value Edges for the function arguments
						s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));
					}
					return false;
				}

				case 'new': {
					// Always treated as an effect, like an impure call -- a constructor can run
					// arbitrary code, so there's no equivalent of `call`'s "pureFoo" opt-in here.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectValue(end, 0, node, 0);
					end = node;
					s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));
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
					connectValue(end, 0, node, 0);
					end = node;
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
					connectValue(end, 0, node, 0);
					end = node;
					s.quasi.forEach((part, index) => {
						if (part.exp)
							connectValue(getExprNode(part.exp), 0, node, index + 1);
					});
					return false;
				}

				case 'class': {
					// A class expression's own definition can run arbitrary code (a computed key, a
					// field initializer, or the heritage clause can all call out) -- always order-anchored,
					// exactly like 'new'. `process(s)` already walks members/heritage/computed-keys
					// generically (walker.ts's own classMember handling), so any calls nested inside
					// correctly thread into the state chain; the class body itself isn't decomposed into
					// the graph any further than that (the same partial-fidelity 'call' already accepts
					// for its own callee -- see buildEffectExpr), so a GCM-moved value referenced inside
					// a method/initializer body won't be reflected in the reconstructed literal.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectValue(end, 0, node, 0);
					end = node;
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
					connectValue(end, 0, node, 0);
					end = node;
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
					const outer = getState();

					// 1. Establish the internal localized graph builder context

					// 2. Instantiate the Function Boundary Nodes
					const entryNode		= makeExprNode(s);
					const returnNode	= makeNode('effect', 'RETURN_ANCHOR');

					// 3. Seed an isolated local scope for the function body
					// This isolates function variables completely from the outer global scope
					const fnScope = new Scope(scope);

					// Wire incoming output ports from the entry node directly to parameter bindings.
					// Each param gets its own node (port 0 = State, so params occupy port index + 1);
					// without a dedicated node per param they'd all alias entryNode's port 0.
					s.params.forEach((p, index) => {
						if (typeof p.key === 'string') {
							const paramNode = makeNode('var', p.key);
							connectValue(entryNode, index + 1, paramNode, 0);
							fnScope.create(p.key, paramNode);
						} else {
							console.log(`not handling destructured parameter`);
						}
					});

					// 4. Temporarily swap the master compiler pointers into the function's region

					// The sequential state chain inside the function hangs off the entry node
					setState(fnScope, entryNode);

					// 5. Recursively walk and generate the entire function body statements block
					process(s);

					// 6. Connect the final sequential execution state to the return anchor
					connectValue(end, 0, returnNode, 0); // Slot 0 = Final State

					// 7. An expression-bodied arrow (`x => x + 1`) has no `return` statement at all --
					// its body IS the implicit return value; `process(s)` above already walked the bare
					// expression body through the expression hook (walker.ts's own 'arrow' case routes a
					// non-array body there), so its resolved node is available directly. A block-bodied
					// arrow/function has none of that -- every explicit `return` inside now prints
					// itself in place (see the 'return' case's own comment), so port 1 here is left
					// otherwise unused; a synthetic `undefined` just keeps the port populated.
					const finalReturnValNode = s.type === 'arrow' && !Array.isArray(s.body)
						? getExprNode(s.body)
						: makeNode('literal', undefined);
					connectValue(finalReturnValNode, 0, returnNode, 1); // Slot 1 = Return Value

					// 8. Restore the master compiler pointers back to the global file scope
					setState(outer.scope, outer.end, outer.exited, outer.brokeOut);
					return false;
				}

				case 'member': {
					process(s);
					const node = makeNode('member', s.property);
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
					process(s);
					const node = makeExprNode(s);
					s.properties.forEach((prop, index) => {
						if (prop.type === 'spread') {
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
		}
	);
	return graph;
}

export class Output {
	nodeVariableNames	= new Map<NodeId, string>();
	declaredNames		= new Set<string>();
	tempVarCounter		= 0;

	constructor(public graph: Map<NodeId, Node>) {}

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
	private valueConsumers(node: Node): Edge[] {
		const CONTROL = new Set(['effect', 'gamma', 'gammaValue', 'mu', 'muValue', 'theta', 'thetaValue', 'break_scope', 'except', 'function_decl', 'passthru']);
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

	// A call is safe to inline directly into its consumer (skipping its own `const tN = f();`
	// statement entirely) only under a narrower condition than a pure value: it must have EXACTLY one
	// value-consumer, AND that consumer must also be the call's own DIRECT state-chain successor (an
	// edge to it at port 0) -- i.e. nothing else can possibly run between them. That's what makes
	// `g(h())` safe (h's only consumer, g, is also h's immediate next state-chain step) but rules out
	// e.g. a call whose sole reader is reached only after something else happens first, where
	// inlining would silently move the call's execution point. A single-value-consumer check alone
	// isn't enough for effects the way it is for pure values, since pure recomputation is free but
	// re-running a call is not -- this only ever removes a statement, never re-runs one.
	private isInlinableEffect(node: Node): boolean {
		const consumers = this.valueConsumers(node);
		if (consumers.length !== 1)
			return false;
		const consumer = this.graph.get(consumers[0].nodeId)!;

		// Case 1: the consumer is itself another call, and IS this call's direct state successor
		// (e.g. `g(h())`).
		if (this.isEffect(consumer))
			return (node.outputs[0] ?? []).some(e => e.nodeId === consumer.id && e.port === 0);

		// Case 2: the consumer is a named-slot rebind (a var_decl or a reassignment -- e.g. `let y =
		// g();` or `x = g();`) whose OWN mutation-marker (port 2; see threadMutation) is this call's
		// direct state successor. Nothing can run between the call and the marker (that's the
		// marker's entire job), so this is exactly as safe as inlining into another call -- just one
		// more hop, through the marker, to find the real successor.
		const markerEdge = consumer.inputs[2];
		return !!markerEdge && (node.outputs[0] ?? []).some(e => e.nodeId === markerEdge.nodeId && e.port === 0);
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
	private needsTemp(node: Node): boolean {
		// A named theta's own condition edge is real in the GRAPH (GCM needs it) but never actually
		// read by codegen (see isVestigialEdge) -- e.g. a while loop's own test feeds not just the
		// state-theta's condition (the one real read) but ALSO every named theta's condition port,
		// one per loop-carried variable. Left uncounted, a loop with two loop-carried variables would
		// see the test as "reused" and give it a needless temp even though it's read exactly once.
		const consumers = (node.outputs[0] ?? []).filter(e => !this.graph.get(e.nodeId)!.isVestigialEdge(e.port));
		// NEITHER of a mu's own input ports -- initial value (0) or feedback (1) -- is ever actually
		// READ via resolveNode/inlining: the mu itself is what's read everywhere it's used (as a plain
		// Identifier), never these edges. They're purely structural (what to start the loop-carried
		// variable at, what updates it each iteration), so a producer feeding either must always be a
		// real, materialized statement -- skipping it here would silently drop it instead of inlining
		// it anywhere (`i = i + 1;` vanishing and `i` never advancing; `i`'s own `= 0` going missing
		// and starting the loop from `undefined`).
		if (consumers.some(e => { const t = this.graph.get(e.nodeId)!.type; return t === 'mu' || t === 'muValue'; }))
			return true;
		// A rebind's own "old value"/left-operand edge (port 0 of a prefix/postfix unary or a compound
		// assignment) needs the producer addressable BY NAME in the reconstructed mutating syntax
		// (`++i`, `i += 1`) -- inlining the producer away as a bare literal there (safe for an ordinary
		// pure consumer, which just recomputes a value) would silently turn a real mutation into a
		// no-op recompute instead (`++0` printed in place of `++i`, `i` itself never advancing).
		if (consumers.some(e => {
			const target = this.graph.get(e.nodeId)!;
			if (e.port !== 0)
				return false;
			if (target.type === 'unary_post')
				return true;
			if (target.type === 'unary') {
				const op = (target.value as Expr & { type: 'unary' }).operator;
				return op === '++' || op === '--';
			}
			return target.type === 'binary' && ASSIGN_OPS.has((target.value as Expr & { type: 'binary' }).operator);
		}))
			return true;
		// A postfix ++/--'s captured old-value snapshot (see 'unary_post' in BuildVSDG) exists solely
		// to freeze `i`'s value at this exact point, before the increment -- inlining it into a
		// consumer scheduled later (past the increment) would read the WRONG, already-mutated value.
		// Unlike an ordinary pure value, it's never safe to lazily recompute at the consumer's own
		// position, so any real consumer at all -- not just a second one -- forces it to materialize
		// here, at its own (correctly state-anchored) point instead.
		if (node.type === 'unary_post_old')
			return consumers.length > 0;
		return consumers.length > 1;
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
	// visited by blocksToAST's traversal at all, so it can end up scheduled into a block nothing
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
				|| node.value.type === 'tagged_template' || node.value.type === 'class' || node.value.type === 'jsx');
	}

	private buildEffectExpr(node: Node): Expr {
		const value = node.value as (Expr & {type: 'call' | 'new' | 'yield' | 'tagged_template' | 'class' | 'jsx'});
		if (value.type === 'yield')
			return { ...value, operand: value.operand ? this.resolveOperand(node.id, 1) : undefined };
		if (value.type === 'tagged_template')
			return { ...value, quasi: value.quasi.map((part, i) => part.exp ? { ...part, exp: this.resolveOperand(node.id, i + 1) } : part) };
		if (value.type === 'class')
			return value;
		if (value.type === 'jsx') {
			let port = 1;
			return {
				...value,
				attributes: value.attributes.map(a => a.value ? { ...a, value: this.resolveOperand(node.id, port++) } : a),
				children: value.children.map(() => this.resolveOperand(node.id, port++)),
			};
		}
		return { ...value, arguments: value.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
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
			case 'arrow':
			case 'function':
				// GCM never moves anything INTO or OUT OF a function/arrow body (it's an isolated
				// sub-region, walked into its own entry/return-anchor pair -- see BuildVSDG's own case),
				// so node.value is still the original, untouched AST for the whole expression -- safe
				// to print verbatim, same partial-fidelity 'class' already accepts for its own body.
				return node.value as Expr;
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
			case 'gammaValue': {
				// A state gamma never reaches here at all -- reconstructed separately by blocksToAST.
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
				return JS.Member(this.resolveOperand(node.id, 0), node.value as string);
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
				// Reaching here means an inlinable EFFECTFUL call (see isInlinableEffect) was left
				// unmaterialized and its sole consumer is now resolving it directly. Other 'effect'
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
			return JS.VarDecl(node.declKind, JS.Var(name, expr)) as Statement;
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
	// position, so it stays combined with the declaration there (see isInlinableEffect for how the
	// call attaches). A DEAD effectful initializer is handled separately, in emitNamedSlot: the call
	// still needs to run, just not as x's value (see hasRealConsumer there).
	private isInlinableVarDecl(node: Node): boolean {
		return node.type === 'var' && !!node.inputs[0]
			&& !this.needsTemp(node) && this.isPureSubgraph(this.graph.get(node.inputs[0].nodeId)!);
	}

	// Conservative, single-pass purity check over `node`'s own transitive inputs: true only if NO
	// effect (call) appears anywhere in the subgraph that produces it.
	private isPureSubgraph(node: Node, seen = new Set<NodeId>()): boolean {
		if (seen.has(node.id))
			return true;
		seen.add(node.id);
		if (node.type === 'effect')
			return false;
		return node.inputs.every(e => !e || this.isPureSubgraph(this.graph.get(e.nodeId)!, seen));
	}

	private emitNamedSlot(name: string, node: Node): Statement {
		if (node.type === 'var') {
			if (node.inputs[0]) {
				// Either the initializer is pure and doesn't need printing under x's own name
				// (isInlinableVarDecl), or x's value is dead outright regardless of purity -- an
				// effectful dead initializer still needs to RUN (materialized separately as its own
				// statement, via the ordinary isEffect path -- see valueConsumers), just not attached
				// to x: `let x = f();` where x is dead becomes bare `let x;` plus a standalone `f();`.
				if (node.declKind && (this.isInlinableVarDecl(node) || !this.hasRealConsumer(node))) {
					this.declaredNames.add(name);
					return JS.VarDecl(node.declKind, JS.Var(name)) as Statement;
				}
				return this.declareOrAssign(name, node, this.resolveOperand(node.id, 0));
			}
			this.declaredNames.add(name);
			return JS.VarDecl(node.declKind ?? 'let', JS.Var(name)) as Statement;
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

		if (node.type === 'literal')
			return Literal(node.value);

		// A local declaration left bare (see isInlinableVarDecl) never actually assigned its name --
		// its sole reader inlines the (pure) initializer directly instead of reading the name back.
		if (node.type === 'var' && this.isInlinableVarDecl(node))
			return this.resolveOperand(id, 0);

		// Params and declared locals alike are just a name to read; whether a DECLARATION statement is
		// also needed for a local is handled separately, by emitLocalStatements's nodeSlotName check.
		if ((node.type === 'var' && typeof node.value === 'string') || node.type === 'muValue')
			return Identifier(node.value);

		// A thetaValue's exported value IS its mu source's value, unchanged -- it exists only to mark
		// where a loop-carried variable becomes readable again after the loop, not to compute
		// anything itself.
		if (node.type === 'thetaValue')
			return this.resolveOperand(id, 1);

		const name = node.slotName();
		if (name !== undefined && !this.isInlinableSlot(node))
			return Identifier(name);

		const varName = this.nodeVariableNames.get(id);
		if (varName)
			return Identifier(varName);

		// Not materialized as a statement anywhere reachable -- most commonly a pure value (e.g. one
		// branch's reassignment candidate, now feeding only a per-variable named gamma) whose own
		// block was never visited, because a no-real-effect if/else has no structural wrapper for
		// blocksToAST to reach it through. Building it inline is always safe for a pure value: it just
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

		const visit = (id: NodeId) => {
			if (visited.has(id))
				return;
			// Marked visited BEFORE recursing (not after): a mu's feedback edge is a genuine back-edge
			// (that's what makes it a loop) -- marking early means a cycle that reaches back here just
			// gets skipped by the `visited.has` check above, instead of recursing forever.
			visited.add(id);

			const node = this.graph.get(id)!;

			// mu/theta/var/literal resolve directly (a name lookup or a constant), never by combining
			// their own inputs -- in particular, a mu's port-1 feedback edge points at whatever the
			// loop body computes from the mu ITSELF, so following it here as an ordinary "compute this
			// first" dependency is both unnecessary (the mu never needs it to resolve) and cyclic.
			if (node.type !== 'mu' && node.type !== 'muValue' && node.type !== 'theta' && node.type !== 'thetaValue' && node.type !== 'var' && node.type !== 'literal') {
				// Before emitting this node, all its inputs that belong to the SAME block must be emitted first
				for (const edge of node.inputs) {
					if (edge && nodeSet.has(edge.nodeId))
						visit(edge.nodeId);
				}
			}

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
				if (this.isInlinableEffect(node))
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
				statements.push(this.emitNamedSlot(name, node));
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
					// Same partial-fidelity treatment as a 'class' expression's buildEffectExpr: the
					// body isn't decomposed through the graph, so node.value is still the original,
					// untouched declaration -- printed verbatim, as its own real statement (a
					// declaration always prints regardless of whether the class is ever referenced,
					// same as var_decl -- unlike an ordinary value, there's no "unused, so inline or
					// drop it" question for a declaration).
					statements.push(node.value as Statement);
					break;

				case 'function_decl':
					// Always intercepted earlier, by emitFrom's own per-block dispatch (function_decl
					// is a rootBlocks anchor, always alone in its own block) -- reaching here would mean
					// that dispatch was skipped somehow. No-op rather than silently mis-printing it as
					// an ordinary unresolved value.
					break;

				default:
					if (this.needsTemp(node))
						statements.push(JS.VarDecl('var', JS.Var(this.makeTempVar(id), this.buildExpr(node))));
					// else: single-use, same-block -- left unmaterialized; its sole consumer inlines it
					// directly via resolveNode's fallback when it resolves this operand.
			}
		}

		return statements;
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
function foldDeadBranches(graph: VSDG, node: Node): boolean {
	// We are looking for Gamma nodes (gammaValue or the state gamma)
	if (node.type !== 'gamma' && node.type !== 'gammaValue')
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
		// and reconnect them to read directly from the winning branch source.
		const winningNode = graph.getNode(winningEdge.nodeId);
		for (const edge of node.outputs[0]) {
			edge.nodeId = winningEdge.nodeId;
			edge.port   = winningEdge.port;
			winningNode.outputs[0].push(edge);
		}

		// Delete the Gamma node and its incoming edges from the graph
		graph.removeNode(node);
		return true; // Graph was modified!
	}

	return false;
}

function getStructuralKey(node: Node): string {
	let key = node.type;
	if (node.value) {
		switch (node.type) {
			case 'binary':
			case 'unary': key += (node.value as any).operator;
				break;
			default: key += node.value;
		}
	}

	return key + ':' + node.inputs.map(e => e ? `${e.nodeId}:${e.port}` : '').join(',');
}

export function optimizeStructuralCSE(graph: VSDG): boolean {
	let anyChanges = false;

	// Maps a structural string signature back to the first Node that computed it
	const structuralTable = new Map<string, Node>();

	for (const node of graph.values()) {
		// Skip nodes with side-effects or loop/branch control flow tokens.
		// These are sequence-dependent and cannot be collapsed based purely on data inputs.
		if (['mu', 'muValue', 'theta', 'thetaValue', 'gamma', 'gammaValue', 'effect'].includes(node.type))
			continue;

		// Generate the unique structural signature for this node
		const key = getStructuralKey(node);

		// Check if an identical calculation has already been recorded
		const masterNode = structuralTable.get(key);

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
	// 'block_entry' directly, rather than an auto-numbered one like every other anchor -- blocksToAST
	// needs a fixed, known starting point to begin its traversal from.
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
		} else if (node.type === 'function_decl' || node.type === 'passthru') {
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

		// Default to the first entry block of the program
		let earliestBlock = "block_entry";

		// Recursively process all input dependencies first
		const node = graph.get(nodeId)!;// as NodeWithBlock;
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
			scheduleEarly(edge.nodeId);
			// The current node must be scheduled AFTER its inputs are ready.
			// We find the deepest block among all inputs.
			if (blockIds.has(edge.nodeId) && isDeeperThan(blockTree, blockIds.get(edge.nodeId), earliestBlock))
				earliestBlock = blockIds.get(edge.nodeId)!;
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

	return { blockIds, blockControl };
}

export function blocksToAST(
	blockIds:		Map<NodeId, BlockId>,
	blockControl:	Map<BlockId, NodeId>,
	graph:			Map<NodeId, Node>
): Statement[] {
	const output	= new Output(graph);
	const emitted	= new Set<BlockId>();
	const CONTROL	= new Set(['effect', 'gamma', 'gammaValue', 'mu', 'muValue', 'theta', 'thetaValue', 'break_scope', 'except', 'function_decl', 'passthru']);

	// Which nodes GCM scheduled into each block -- the inverse of blockIds, grouped once up front
	// rather than carried around as its own returned data structure (a block's node list has no
	// identity of its own beyond "whichever nodes point at this blockId").
	const blockNodes = new Map<BlockId, NodeId[]>();
	for (const id of graph.keys()) {
		const bId = blockIds.get(id) || 'block_entry';
		if (!blockNodes.has(bId))
			blockNodes.set(bId, []);
		blockNodes.get(bId)!.push(id);
	}

	// Finds the next block in the SAME state-chain -- i.e. "whatever comes next in sequence" -- by
	// following this control node's state output to whichever consumer reads it as ITS OWN state
	// input (port 0 on another control-anchor node). Other port-0 consumers can exist too (e.g. a
	// `let y = f();` wrapper reading a call's return value at ITS OWN port 0), so the target's type
	// has to be checked as well as the port, or those would be mistaken for "the next block."
	function successorBlock(control: Node): BlockId | undefined {
		// At a branch point, `control`'s output can have several simultaneous port-0 consumers: the
		// first effect of EACH branch (each branch independently treats `control` as ITS OWN state
		// predecessor) AND the eventual merge-gamma (same reasoning: `parent.end` -- this function's
		// `control` -- is the gamma's own predecessor too). Only the gamma is really "what comes next
		// in sequence"; a branch's own entry is reachable ONLY via the gamma's own branchEntryBlock
		// lookup, as nested content, not as an ordinary successor.
		//
		// When NEITHER branch had a real effect, no gamma gets created at all (the if/else fully
		// dissolves into a per-variable named gamma instead), and each branch's mutation-ordering
		// markers are left dangling off `control` with nothing to distinguish them from the REAL
		// continuation that follows the whole if-statement -- also a direct port-0 consumer of the
		// same `control`. Preferring the LAST such candidate (over the first) resolves it correctly:
		// the AST walk always finishes walking a branch's entire content before it ever reaches
		// whatever comes textually after the if, so the real continuation is always inserted last.
		let fallback: BlockId | undefined;
		for (const edge of control.outputs[0] ?? []) {
			if (edge.port !== 0)
				continue;
			const target = graph.get(edge.nodeId)!;
			if (target.type === 'gamma' || target.type === 'gammaValue' || target.type === 'mu' || target.type === 'muValue' || target.type === 'break_scope' || target.type === 'except') {
				const id = blockIds.get(edge.nodeId);
				if (id)
					return id;
			} else if (CONTROL.has(target.type)) {
				fallback = blockIds.get(edge.nodeId) ?? fallback;
			}
		}
		return fallback;
	}

	// The mirror image of successorBlock: given the LAST node of a branch/loop-body (e.g. a gamma's
	// own trueState/falseState input, or a mu's own feedback input) and the boundary node it started
	// right after, walks the state chain backwards (via inputs[0], now consistently the real
	// predecessor for every control-anchor type) to find the FIRST block of that branch/body -- the
	// entry point emitFrom needs to start its forward walk from. Not stored on the node itself: it's
	// fully recoverable on demand from data the graph already has, the same way blockTree itself is.
	function branchEntryBlock(tailNodeId: NodeId, boundaryNodeId: NodeId): BlockId | undefined {
		let entryBlockId: BlockId | undefined;
		let currentId = tailNodeId;
		while (currentId !== boundaryNodeId) {
			entryBlockId = blockIds.get(currentId);
			const pred = graph.get(currentId)?.inputs[0];
			if (!pred)
				break;
			currentId = pred.nodeId;
		}
		return entryBlockId;
	}

	// Emits a block plus everything that follows it in sequence at this same nesting level (an
	// ordinary run of blocks, walked forward via successorBlock -- NOT Map/graph iteration order,
	// which has no guaranteed relationship to actual control-flow order).
	function emitFrom(blockId: BlockId | undefined): Statement[] {
		const statements: Statement[] = [];

		while (blockId && !emitted.has(blockId)) {
			emitted.add(blockId);
			const nodes		= blockNodes.get(blockId) ?? [];
			const control	= graph.get(blockControl.get(blockId) ?? blockId)!;

			if (control.type === 'gamma') {
				// A gamma anchoring its own block is a STATE merge (an if/else where at least one
				// branch has a side effect) -- gammaValues are pure values, never anchor their own
				// block, and are handled by emitLocalStatements instead.
				// Ports, per the reordering above: 0 = predecessor, 1 = condition, 2 = true tail, 3 = false tail.
				const predecessorId	= control.inputs[0].nodeId;
				const trueEntryId		= branchEntryBlock(control.inputs[2].nodeId, predecessorId);
				const falseEntryId	= branchEntryBlock(control.inputs[3].nodeId, predecessorId);

				// Anything else GCM scheduled alongside the merge itself needs to be split by whether
				// it's a DEPENDENCY of the gamma (e.g. a `let a = ...;` the test itself reads -- must
				// print BEFORE the if) or a DEPENDENT of it (reads the merged result -- prints after).
				// Blindly appending everything after the if was wrong: it printed the test variable's
				// own declaration AFTER the `if` that already reads it.
				const sortedIds	= output.localTopologicalSort(nodes);
				const gammaIndex	= sortedIds.indexOf(control.id);
				statements.push(...output.emitLocalStatements(sortedIds.slice(0, gammaIndex)));
				statements.push(JS.If(
					output.resolveOperand(control.id, 1),
					JS.Block(...emitFrom(trueEntryId) as JS.Statement<any>[]),
					falseEntryId ? JS.Block(...emitFrom(falseEntryId) as JS.Statement<any>[]) : undefined
				) as Statement);
				statements.push(...output.emitLocalStatements(sortedIds.slice(gammaIndex + 1)));
				blockId = successorBlock(control);
				continue;
			}

			if (control.type === 'break_scope') {
				// A scope that `break` exits but `continue` does NOT re-enter (unlike a loop) --
				// reconstructed as a minimal, always-matching `switch`, purely for that "break exits
				// me" property. Real JS's own `continue` already correctly skips PAST a switch to
				// the nearest REAL enclosing loop, which is exactly why this isn't a `while (true)`
				// wrapper (see BuildVSDG's 'switch' case for the infinite-loop bug that came from
				// using one). Ports mirror a gamma's: 0 = predecessor, 1 = the scope's own tail.
				const predecessorId	= control.inputs[0].nodeId;
				const contentEntryId	= branchEntryBlock(control.inputs[1].nodeId, predecessorId);

				const sortedIds	= output.localTopologicalSort(nodes);
				const scopeIndex	= sortedIds.indexOf(control.id);
				statements.push(...output.emitLocalStatements(sortedIds.slice(0, scopeIndex)));
				statements.push(JS.Switch(Literal(0), JS.SwitchCase(Literal(0),
					...(contentEntryId ? emitFrom(contentEntryId) : []) as JS.Statement<any>[]
				)) as Statement);
				statements.push(...output.emitLocalStatements(sortedIds.slice(scopeIndex + 1)));
				blockId = successorBlock(control);
				continue;
			}

			if (control.type === 'except' && typeof control.value !== 'string') {
				// Reconstructed as a real `try {...} catch (e) {...}` (optionally `finally {...}`)
				// -- no rotation or synthetic wrapper needed, unlike a loop or switch: try/catch is
				// already exactly the shape it needs to be. Ports: 0 = predecessor, 1 = try's own
				// tail, 2 = catch's own tail, 3 = finally's own tail (only if finally exists).
				const predecessorId	= control.inputs[0].nodeId;
				const tryEntryId	= branchEntryBlock(control.inputs[1].nodeId, predecessorId);
				const catchEntryId	= branchEntryBlock(control.inputs[2].nodeId, predecessorId);

				const sortedIds		= output.localTopologicalSort(nodes);
				const exceptIndex	= sortedIds.indexOf(control.id);
				statements.push(...output.emitLocalStatements(sortedIds.slice(0, exceptIndex)));

				// finally's own tail (port 3) is anchored back on `control` itself, not
				// `predecessorId` -- its own first statement's predecessor is the except node
				// directly (see BuildVSDG's 'try' case), not the state from before the whole
				// try/catch, so that's the boundary its own backward walk needs to stop at.
				const finallyEdge	= control.inputs[3];
				const finallyEntryId = finallyEdge ? branchEntryBlock(finallyEdge.nodeId, control.id) : undefined;

				statements.push({
					type:			'try',
					block:			emitFrom(tryEntryId) as JS.Statement<any>[],
					handlerParam:	control.catchParam,
					handlerBody:	emitFrom(catchEntryId) as JS.Statement<any>[],
					finalizer:		finallyEdge ? emitFrom(finallyEntryId) as JS.Statement<any>[] : undefined,
				} as Statement);

				statements.push(...output.emitLocalStatements(sortedIds.slice(exceptIndex + 1)));
				blockId = successorBlock(control);
				continue;
			}

			if (control.type === 'function_decl') {
				// Recurse into the function's OWN internal region -- its body is a fully independent
				// sub-graph (own entry/RETURN_ANCHOR pair, own scope), scheduled by the very same GCM
				// pass that scheduled everything at this level, so the exact same block-walking
				// machinery reconstructs it. returnNodeId (stamped in BuildVSDG) is the only way to
				// find the RETURN_ANCHOR from here -- there's no ordinary graph edge from entry to
				// return that survives an empty body (see the Node field's own comment).
				const returnNode	= graph.get(control.returnNodeId!)!;
				const bodyEntryId	= branchEntryBlock(returnNode.inputs[0].nodeId, control.id);
				const bodyStatements = bodyEntryId ? emitFrom(bodyEntryId) : [];

				const returnValueNode = graph.get(returnNode.inputs[1].nodeId)!;
				// Both "no return statement at all" and a bare `return;` fall back to the SAME
				// synthetic literal(undefined) (see BuildVSDG's 'function_decl'/'return' cases) --
				// indistinguishable from an explicit `return undefined;` here, but all three are
				// runtime-equivalent, so omitting the trailing statement is never wrong, just
				// sometimes less literal than the original source.
				if (!(returnValueNode.type === 'literal' && returnValueNode.value === undefined))
					bodyStatements.push({ type: 'return', argument: output.resolveOperand(returnNode.id, 1) } as Statement);

				const sortedIds	= output.localTopologicalSort(nodes);
				const declIndex	= sortedIds.indexOf(control.id);
				statements.push(...output.emitLocalStatements(sortedIds.slice(0, declIndex)));
				statements.push({ ...(control.value as JS.FunctionDecl<any>), body: bodyStatements } as Statement);
				statements.push(...output.emitLocalStatements(sortedIds.slice(declIndex + 1)));
				blockId = successorBlock(control);
				continue;
			}

			if (control.type === 'mu') {
				const thetaEdge	= (control.outputs[0] ?? []).find(e => graph.get(e.nodeId)!.type === 'theta');
				const thetaNode	= thetaEdge && graph.get(thetaEdge.nodeId)!;

				// The mu's own block holds the mu node itself plus any loop-body computation whose
				// only real dependency IS the mu (e.g. `i = i + 1;` with no calls in the body) -- GCM
				// schedules those into the mu's own block since there's no other anchor to place them
				// at. Anything with a real effect continues from the body's entry block, chained
				// forward as usual (port 1 = the mu's own feedback input, i.e. the body's tail node).
				const ownIds			= nodes.filter(id => id !== control.id);
				const bodyEntryId		= branchEntryBlock(control.inputs[1].nodeId, control.id);
				const restOfBody		= bodyEntryId ? emitFrom(bodyEntryId) : [];

				if (thetaNode) {
					const testId	= thetaNode.inputs[1].nodeId;
					const testNode	= graph.get(testId)!;
					// The test's only REAL reader (besides itself) is normally the state-theta's own
					// condition port -- everything else pointing at it (each named theta's own
					// condition port, one per loop-carried variable) is vestigial, never actually read
					// by codegen. When that's the whole story, force-materializing it via a standalone
					// emitLocalStatements call (which only sees this one node, with no way to know its
					// true consumer is the theta it's about to be resolved through anyway) would make
					// `needsTemp` see it as "reused across a block boundary" and spill it needlessly --
					// so skip that and let `resolveOperand(thetaNode.id, 1)` below inline it directly.
					const onlyReadByLoopExit = (testNode.outputs[0] ?? []).filter(e => !graph.get(e.nodeId)!.isVestigialEdge(e.port))
						.every(e => e.nodeId === thetaNode.id);
					const testStatements	= onlyReadByLoopExit ? [] : output.emitLocalStatements([testId]);
					const restStatements	= output.emitLocalStatements(ownIds.filter(id => id !== testId));

					if (control.loopKind === 'do') {
						// No rotation needed: unlike `while`, the body already runs before the test in
						// do-while's own native semantics (the mu's INITIAL value is what the body sees
						// on its first pass) -- `do { body } while (test);` reconstructs directly.
						statements.push(JS.DoWhile(JS.Block(
							...restOfBody as JS.Statement<any>[],
							...restStatements as JS.Statement<any>[],
							...testStatements as JS.Statement<any>[]
						), output.resolveOperand(thetaNode.id, 1)) as Statement);
					} else {
						// LOOP ROTATION: the condition is computed using the mu nodes' CURRENT (this
						// iteration's) values, which only exist once we're already inside the loop body
						// -- there is no way to compute it "before" a `while (cond) { ... }` header, since
						// the header would need something the body alone provides. `while (cond) { body }`
						// is structurally impossible here; `while (true) { <compute cond>; if (!cond) break; body }`
						// isn't -- it just moves the same condition check to the top of the body instead
						// of the (unavailable) position before it.
						statements.push(JS.While(Literal(true), JS.Block(
							...testStatements as JS.Statement<any>[],
							JS.If({ type: 'unary', operator: '!', operand: output.resolveOperand(thetaNode.id, 1) } as Expr,
								JS.Block({ type: 'break' } as JS.Statement<any>)
							) as JS.Statement<any>,
							...restStatements as JS.Statement<any>[],
							...restOfBody as JS.Statement<any>[]
						)) as Statement);
					}
				} else {
					// No exit condition could be found at all (shouldn't normally happen -- every
					// `while` creates a state-theta) -- fall back to reconstructing without rotation.
					statements.push(JS.While(Literal(true),
						JS.Block(...output.emitLocalStatements(ownIds) as JS.Statement<any>[], ...restOfBody as JS.Statement<any>[])
					) as Statement);
				}

				if (thetaNode) {
					// Anything scheduled into the state-theta's OWN block (besides the theta node
					// itself) needs to be emitted explicitly here, right after the loop: a pure
					// computation that depends only on a named theta's exported value (no state edge
					// at all -- e.g. a side-effect-free call, once purity analysis exists) has nothing
					// to state-chain through, so successorBlock below would never otherwise find it.
					const thetaBlockId = blockIds.get(thetaNode.id);
					const thetaBlockNodes = thetaBlockId && blockNodes.get(thetaBlockId);
					if (thetaBlockNodes)
						statements.push(...output.emitLocalStatements(thetaBlockNodes.filter(id => id !== thetaNode.id)));
				}

				blockId = thetaNode ? successorBlock(thetaNode) : undefined;
				continue;
			}

			statements.push(...output.emitLocalStatements(nodes));
			blockId = successorBlock(control);
		}

		return statements;
	}

	return emitFrom('block_entry');
}
