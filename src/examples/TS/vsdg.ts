import * as JS from './js-parser';
import * as TS from './ts-parser';
import { Identifier, Literal } from '../common';
import { Walkable, walkB, calcUnary, calcBinary } from './walker';

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
	constructor(public id: string, public type: string, public value?: any) {}
	inDegree()	{ return this.inputs.length; }
	outDegree() { return this.outputs.reduce((sum, arr) => sum + arr.length, 0); }
	isUnused(port: number) { return this.outputs[port]?.length === 0; }

	// A node's real source-variable name, if it has one -- either a direct rebind (var_decl/reassignment/++--,
	// tagged via `boundName`) or a state-merge's per-variable gamma (which stores the name in `.value` instead,
	// since `.value` is otherwise free for a gamma -- unlike binary/unary nodes, which need it for their operator).
	slotName(): string | undefined {
		if (this.boundName !== undefined)
			return this.boundName;
		if (this.type === 'gamma' && typeof this.value === 'string')
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
	//  - A NAMED theta's "condition" edge (port 0): resolveNode always resolves a named theta through
	//    its mu source (port 1) instead -- the condition edge exists only so GCM can see the dependency
	//    that makes the export valid no earlier than loop-exit, never because codegen reads it.
	isVestigialEdge(port: number): boolean {
		if (this.type === 'binary' && port === 0
			&& ASSIGN_OPS.has((this.value as Expr & { type: 'binary' }).operator)
			&& (this.value as Expr & { type: 'binary' }).operator === '='
		)
			return true;
		if (this.type === 'theta' && typeof this.value === 'string' && port === 0)
			return true;
		// A state-merging (unnamed) gamma's true/false-tail ports (2/3) are structural only: blocksToAST
		// reads `control.inputs[2]/[3]` directly (via branchEntryBlock) to find where each branch's
		// content starts, never through resolveOperand -- so a call that happens to be the last effect in
		// its branch is never actually "read" for its VALUE just by virtue of being that branch's tail.
		return this.type === 'gamma' && typeof this.value !== 'string' && (port === 2 || port === 3);
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
			const mu = this.makeNode('mu', name);
			this.muNodes.set(name, mu);		//original mu
			this.bindings.set(name, mu);	// current node
			connectValue(old, 0, mu, 0);			// Slot 0 = Initial value from outside
			connectValue(this.stateAnchor, 0, mu, 2);	// Slot 2 = scheduling-only: "at least as deep as the loop"
			return mu;
		}
	}
}

class VSDG {
	graph	= new Map<NodeId, Node>;

	getNode(id: NodeId): Node {
		const node = this.graph.get(id);
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
		this.graph.delete(node.id);
	}

	clearDeadNodes() {
		for (let changed = true; changed; ) {
        	changed = false;
			for (const node of this.graph.values()) {
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

			for (const node of this.graph.values()) {
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

//export class FunctionDefinition {
//    // Each function maintains its own completely isolated sub-graph context
//    public graph = new Map<NodeId, Node>();
//    public entryNodeId: NodeId;
//    public returnNodeId: NodeId;
//
//    constructor(
//        public name: string,
//        public parameterNames: string[]
//    ) {}
//}

export function BuildVSDG(ast: Walkable) {
	const graph	= new Map<NodeId, Node>;
	const expnodes = new Map<Expr, Node>;
	let scope = new Scope(null); // The global scope
	let nextId = 0;

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

	function makeExprNode(expr: Expr, type: string = expr.type) {
		const node = makeNode(type, expr);
		expnodes.set(expr, node);
		return node;
	}
	function getExprNode(expr: Expr) {
		const node = expr.type === 'identifier' ? scope.get(expr.name) : expnodes.get(expr);
		if (!node)
			throw new Error(`missing node for ${JSON.stringify(expr)}`);
		return node;
	}
	function getState() {
		return { scope, end };
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

	walkB(ast,
		(s, process, recurse) => {
			switch (s.type) {
				case 'function_decl': {
					const outer = getState();
					const outerExited = exited;

					// 1. Establish the internal localized graph builder context

					// 2. Instantiate the Function Boundary Nodes
					const entryNode		= makeNode('function_decl', s);
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

					scope = fnScope;
					end = entryNode; // The sequential state chain inside the function hangs off the entry node
					exited = false;

					// 5. Recursively walk and generate the entire function body statements block
					process(s);

					// 6. Connect the final sequential execution state to the return anchor
					connectValue(end, 0, returnNode, 0); // Slot 0 = Final State

					// 7. Reconcile the returned value expression
					// If the function has a structural return statement (e.g., return x;),
					// your 'return' AST handler will have committed that node to a hidden variable '_return_val'
					const finalReturnValNode = scope.get('_return_val') || makeNode('literal', undefined);
					connectValue(finalReturnValNode, 0, returnNode, 1); // Slot 1 = Return Value

					// 8. Restore the master compiler pointers back to the global file scope
					scope	= outer.scope;
					end		= outer.end;
					exited	= outerExited;
					return false;
				}
				case 'return': {
					// 1. If the return statement carries a value, evaluate it
					if (s.argument) {
						recurse(s.argument, 'expression');
						// Write the returned node to our reserved identifier channel
						scope.set('_return_val', getExprNode(s.argument));
					}

					// 2. Terminate the state sequence for this path
					// In a production VSDG compiler, an early return branches execution state.
					// We update 'end' to signal that this path has completed its state sequence.
					const returnStateMarker = makeNode('effect', 'EARLY_RETURN_MARKER');
					connectValue(end, 0, returnStateMarker, 0);
					end = returnStateMarker;
					// NOT setting `exited = true` here (unlike break/continue): a branch's `_return_val`
					// lives only in that branch's own child scope, which the 'if' handler discards
					// wholesale on restoring `scope = parent.scope` -- it never reaches the function's
					// own final read of it. Marking this branch "exited" would make 'if' build a real
					// gamma and then try to per-variable-merge '_return_val' as an ordinary diverged
					// binding, crashing on whichever branch never set it. Multi-path return value
					// merging is a separate, not-yet-supported gap (pre-existing, unchanged by this
					// session's break/continue work) -- a lone top-level `return` still works correctly.
					return false;
				}
				case 'break':
				case 'continue': {
					// A labeled break/continue can target an OUTER loop/switch, not just the nearest
					// enclosing one -- not supported here (no label-aware target tracking exists), so
					// flag it rather than silently mistargeting.
					if (s.label)
						console.log(`not handling labeled ${s.type}`);
					// No target-tracking needed: unlike a real jump, this doesn't need to know WHICH
					// loop/switch it belongs to. Its only two jobs are (1) mark `exited` so enclosing
					// `if`s correctly treat this branch as not falling through -- which is what keeps
					// whatever textually follows (more of the loop body, more switch cases) from being
					// wired up as if it always runs -- and (2) leave a marker in the state chain so
					// blocksToAST prints a literal `break;`/`continue;` here. The printed statement
					// itself is what real JS routes to the nearest enclosing loop/switch at runtime.
					const marker = makeNode('effect', s.type === 'break' ? 'BREAK_MARKER' : 'CONTINUE_MARKER');
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
					// 1. Evaluate the condition expression to get a value node
					recurse(s.test, 'expression');
					const test		= getExprNode(s.test);
					const parent	= getState();

					// 3. Walk the True branch
					// `recurse`, not `process`: this walks s.consequent ITSELF through the hook (so a bare,
					// non-block consequent like `if (x) let y = 1;` still gets its var_decl/if/while handling);
					// `process` only walks a node's own children, never the node it's given.
					scope = new Scope(parent.scope);
					end = parent.end;
					exited = false;
					recurse(s.consequent);
					const trueState		= getState();
					const trueExited	= exited;

					// 4. Walk the False branch
					// `end` must ALSO be reset here, not just `scope`: without it, the false branch's
					// first effect would chain its state predecessor off the TRUE branch's tail effect
					// (whatever `end` was left as after walking it) instead of `parent.end` -- silently
					// serializing the two branches together (false-branch effects "before" true-branch
					// ones in the state chain) instead of keeping them as independent alternatives.
					scope = new Scope(parent.scope);
					end = parent.end;
					exited = false;
					if (s.alternate)
						recurse(s.alternate);
					const falseState	= getState();
					const falseExited	= exited;

					// 5. Reconcile the STATE - if either branch had a REAL effect (a call -- not just
					// reassignment-ordering markers) OR EXITED (break/continue/return -- the exit
					// statement itself still has to be preserved/printed, and whatever textually
					// follows this if must only run on the non-exited path), we must merge the state
					// paths using a Gamma node.
					if (trueExited || falseExited || hasRealEffect(trueState.end, parent.end) || hasRealEffect(falseState.end, parent.end)) {
						const gamma = makeNode('gamma');
						// Port 0 = the real state predecessor (`parent.end`, the state right before
						// either branch ran) -- kept consistent with every other control-anchor type
						// (effect/mu/theta), so applyGlobalCodeMotion can read a plain `inputs[0]`
						// uniformly instead of needing to know each type's own port layout. Neither
						// `test` nor trueState.end/falseState.end could serve this role: the latter two
						// are AFTER/WITHIN a branch, so using either as "the parent block" would nest
						// the gamma inside whichever branch happened to have the deeper anchor.
						connectValue(parent.end, 0, gamma, 0);		// Slot 0 = State predecessor
						connectValue(test, 0, gamma, 1);				// Slot 1 = Condition
						connectValue(trueState.end, 0, gamma, 2);		// Slot 2 = True State
						connectValue(falseState.end, 0, gamma, 3);	// Slot 3 = False State
						end = gamma;
					} else {
						// No real effect in either branch: the reassignment(s), if any, are already
						// fully captured below by the per-variable named gamma (a pure ternary needs no
						// structural if/else). `end` must still be reset -- left alone, it would dangle
						// off whichever branch's mutation-marker chain was walked last, instead of the
						// state that actually continues after this (structurally absent) if.
						end = parent.end;
					}

					// This whole if-statement only counts as "exited" (to whatever encloses IT) when
					// EVERY path out of it exited -- an implicit empty else (no `s.alternate`) always
					// falls through, so falseExited is correctly false in that case already.
					exited = trueExited && falseExited;

					// 6. Identify the mutations by gathering local keys from both delta scopes
					scope = parent.scope;
					const divergedVariables = new Set([
						...trueState.scope.bindings.keys(),
						...falseState.scope.bindings.keys()
					]);

					// 7. Reconcile only what actually changed
					for (const name of divergedVariables) {
						// '_return_val' is a reserved internal channel (see 'return'), not a real
						// source variable -- it's only ever bound in the SPECIFIC branch that actually
						// returned, never in a branch that fell through normally, so treating it as an
						// ordinary diverged binding would try to gamma-merge it against `undefined` on
						// whichever branch never set it. Real multi-path return-value merging isn't
						// supported (see 'return's own comment) -- this just lets IT (not '_return_val'
						// specifically) survive up to the function level without crashing, for the
						// common case of a single branch that returns.
						if (name === '_return_val') {
							const val = trueState.scope.bindings.get(name) ?? falseState.scope.bindings.get(name);
							if (val)
								scope.set(name, val);
							continue;
						}

						const trueVal	= trueState.scope.get(name)!;
						const falseVal	= falseState.scope.get(name)!;

						// If the values ended up different, create the Gamma stitch
						if (trueVal !== falseVal) {
							// Exactly one branch exited: "after the if" is reachable ONLY via the
							// other (live) branch, so that's the whole merge -- no gamma needed. The
							// exited branch's own value must NOT be merged in (that would defer/inline
							// its reassignment to a print position its break/continue/return already
							// skipped past -- see forcedPrint's own comment for the concrete failure).
							// Force it to print as a real statement instead, exactly where it is.
							if (trueExited !== falseExited) {
								const exitedVal = trueExited ? trueVal : falseVal;
								if (exitedVal.boundName === name)
									exitedVal.forcedPrint = true;
								scope.set(name, trueExited ? falseVal : trueVal);
								continue;
							}

							// Each branch's own PLAIN REASSIGNMENT node (if any) picked up boundName ===
							// name while it was walked as if it might be the final answer -- it's being
							// superseded by the gamma now, so it's no longer really "x" (only the gamma
							// is); left tagged, both branches' `x = ...` would print unconditionally AND
							// the gamma would resolve its operand back to the name it's merging, i.e.
							// print `x = x ? x : x;` instead of the actual branch values.
							// A var_decl's OWN wrapper node must NEVER have its boundName cleared this
							// way, even when it ends up as a merge candidate (e.g. `x` unchanged on one
							// path falls through to its own declaration node as that path's value):
							// declaring the variable is a separate concern from which value merges where,
							// and it's the ONLY thing that ever prints `let x = ...;` at all.
							if (trueVal.boundName === name && !trueVal.declKind)
								trueVal.boundName = undefined;
							if (falseVal.boundName === name && !falseVal.declKind)
								falseVal.boundName = undefined;

							const gamma = makeNode('gamma', name);
							connectValue(test, 0, gamma, 0); 		// Condition
							connectValue(trueVal, 0, gamma, 1);		// True path
							connectValue(falseVal, 0, gamma, 2);	// False path

							// Commit the Gamma node value directly to the parent scope
							// This ensures downstream code after the 'if' sees the merged result!
							scope.set(name, gamma);
						}
					}

					return false;
				}

				case 'while': {
					// 1. Snapshot variables and state that exist before entering the loop
					const preLoop	= getState();

					// 2. Create MU (Entry) nodes for every variable and the global State
					// We need these because the loop body reads variables that mutate across iterations.
					const muEnd		= makeNode('mu');
					const muScope	= new ScopeMu(scope, makeNode, muEnd);

					connectValue(end, 0, muEnd, 0); // Slot 0 = Initial value from outside

					scope	= muScope;
					end		= muEnd;

					// 3. Walk the loop condition expression
					// It evaluates using the values provided by our new Mu entry nodes.
					recurse(s.test, 'expression');
					const test = getExprNode(s.test);

					// 4. Walk the loop body statements
					// `recurse`, not `process` -- see the 'if' case above for why.
					exited = false;
					recurse(s.body);

					// 5. Connect the loop body feedback loops back into the MU nodes (Slot 1)
					// Connect the final side-effect state of the loop body back to the State Mu
					connectValue(end, 0, muEnd, 1);				// Slot 1 = Feedback loop

					// 6. Create the THETA (Exit) node that exports the loop's final STATE. Built before the
					// per-variable thetas below so each of them can anchor to it (see stateAnchor note).
					const stateTheta = makeNode('theta');
					// Port 0 = the real state predecessor (the loop itself, muEnd) -- kept consistent
					// with every other control-anchor type, same reasoning as the state-gamma above.
					connectValue(muEnd, 0, stateTheta, 0);	// Slot 0 = State predecessor (the loop)
					connectValue(test, 0, stateTheta, 1); 	// Slot 1 = Loop termination condition
					end = stateTheta;

					// Connect updated variable values back to their respective Value Mus. Iterating
					// `muNodes` (not `bindings`) matters: `Scope.closeAndFlush` propagates ANY non-local
					// binding straight into its parent's `.bindings` map (bypassing ScopeMu's own `get`
					// override entirely) whenever a nested block closes -- a reserved internal key like
					// '_return_val', once set inside a block nested in this loop, would otherwise show up
					// in `muScope.bindings` with no corresponding `muNodes` entry, crashing `connectValue`
					// below on `undefined`. `muNodes` only ever gets an entry via a REAL loop-carried read
					// (ScopeMu.get), so it's immune to that leak.
					scope = preLoop.scope;
					for (const [name, muNode] of muScope.muNodes) {
						const node = muScope.bindings.get(name)!;
						// The final per-iteration VALUE feeds INTO the mu's own feedback port (mirroring
						// the state-mu's `connectValue(end, 0, muEnd, 1)` right above) -- not the other
						// way around. Reversed, this overwrote `node`'s own port 1 (e.g. a `x = x + 1`
						// node's right-hand operand) with the mu itself, silently corrupting it and
						// orphaning whatever real computation used to be there.
						connectValue(node, 0, muNode, 1);	// Slot 1 = Feedback loop

						const theta = makeNode('theta', name);
						connectValue(test, 0, theta, 0);	// Slot 0 = Condition
						connectValue(muNode, 0, theta, 1);	// Slot 1 = Value to pass out
						// Scheduling-only edge, same reasoning as ScopeMu's `stateAnchor` edge: a named
						// theta isn't a rootBlock anchor (its own ports are a condition and a value, not
						// state), so without this, anything that depends ONLY on this exported value
						// (not on the loop's state -- e.g. `i` read by a pure/non-effect call, or a plain
						// `let x = i + 1;`) has nothing forcing it to be scheduled any later than wherever
						// its own inputs happen to live, which is INSIDE the loop -- floating what should
						// be post-loop code back into the loop body.
						connectValue(stateTheta, 0, theta, 2);
						// Update global environment so downstream code reads the post-loop value
						scope.set(name, theta);
					}
					// The loop AS A WHOLE always falls through to whatever follows it (from the
					// enclosing context's perspective) regardless of whether break/continue happened
					// inside its body -- `exited` here reflects only the body's own last top-level
					// statement, which isn't meaningful once the loop itself has been fully handled.
					exited = false;
					return false;
				}
				case 'switch': {
					// Lowered into an ordinary `if`/`while` cascade and fed back through `recurse`,
					// reusing the if-handler's own exit-tracking/gamma machinery and the while-handler's
					// own mu/theta/loop-rotation machinery entirely as-is -- switch needs no graph
					// machinery of its own beyond this framing.
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
					// next one, exactly as real switch fallthrough does).
					const caseIfs = s.cases.map((c, i) => JS.If(
						{
							type: 'binary', operator: '||',
							left: Identifier(hitName),
							right: matchNames[i] ? Identifier(matchNames[i]!) : negateOr(realMatches),
						} as Expr,
						JS.Block(
							JS.Expression({ type: 'binary', operator: '=', left: Identifier(hitName), right: Literal(true) } as Expr) as JS.Statement<TS.Type>,
							...c.consequent as JS.Statement<TS.Type>[]
						)
					) as JS.Statement<TS.Type>);

					// Wrapped in a single-pass `while (true) { ...; break; }` purely so a `break`
					// anywhere in a case body is syntactically valid and exits the whole switch --
					// the trailing unconditional break ensures it never actually iterates a second
					// time (falling off the end of the last case is exactly as valid an exit as an
					// explicit break).
					recurse(JS.While(Literal(true), JS.Block(...caseIfs, { type: 'break' } as JS.Statement<TS.Type>)) as Statement);
					return false;
				}
				case 'expression':
					break;

				default:
					console.log(`not handling stmt ${s.type}`);
					break;


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

				case 'function': {
					const outer = getState();
					const outerExited = exited;

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

					scope = fnScope;
					end = entryNode; // The sequential state chain inside the function hangs off the entry node
					exited = false;

					// 5. Recursively walk and generate the entire function body statements block
					process(s);

					// 6. Connect the final sequential execution state to the return anchor
					connectValue(end, 0, returnNode, 0); // Slot 0 = Final State

					// 7. Reconcile the returned value expression
					// If the function has a structural return statement (e.g., return x;), 
					// your 'return' AST handler will have committed that node to a hidden variable '_return_val'
					const finalReturnValNode = scope.get('_return_val') || makeNode('literal', undefined);
					connectValue(finalReturnValNode, 0, returnNode, 1); // Slot 1 = Return Value

					// 8. Restore the master compiler pointers back to the global file scope
					scope	= outer.scope;
					end		= outer.end;
					exited	= outerExited;
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

				default:
					// Still walk children of an unhandled node type so anything useful nested inside
					// (e.g. a call) is at least threaded into the graph, even though this node itself isn't.
					process(s);
					console.log(`not handling expr ${s.type}`);
					return false;
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
		const CONTROL = new Set(['effect', 'gamma', 'mu', 'theta']);
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
			if (target.type === 'mu' && e.port === 1)
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
		if (consumers.some(e => this.graph.get(e.nodeId)!.type === 'mu'))
			return true;
		return consumers.length > 1;
	}

	// A named slot (a plain reassignment or a named-gamma merge) whose value can be resolved
	// lazily by its sole consumer instead of needing its own printed statement -- same needsTemp
	// criteria as an anonymous temp, extended to cover 'gamma' as well as 'binary': a named merge
	// feeding ANOTHER named merge (e.g. an `else if` chain building nested per-variable gammas) is
	// exactly as inlinable as an ordinary reassignment feeding the very next statement. Without
	// this, a gamma with a single real consumer still unconditionally resolves to `Identifier(name)`
	// (see resolveNode's own shortcut) -- correct only when something actually printed `name = ...;`
	// for it, which isn't guaranteed: a purely-value merge with no real effect in either branch has
	// no state anchor forcing its own block to be visited by blocksToAST's traversal at all, so it
	// can end up scheduled into a block nothing ever reaches, silently never printed while its
	// consumer still reads its name as if it had been.
	private isInlinableSlot(node: Node): boolean {
		return (node.type === 'binary' || node.type === 'gamma') && !node.forcedPrint && !this.needsTemp(node);
	}

	private isEffect(node: Node): boolean {
		return node.type === 'effect' && !!node.value && typeof node.value === 'object' && node.value.type === 'call';
	}

	private buildEffectExpr(node: Node): Expr {
		const call = node.value as (Expr & {type: 'call'});
		return { ...call, arguments: call.arguments.map((_, i) => this.resolveOperand(node.id, i + 1)) };
	}

	private buildExpr(node: Node): Expr {
		switch (node.type) {
			case 'literal':
				return Literal(node.value);

			case 'unary': {
				const un = node.value as (Expr & {type: 'unary'});
				return { ...un, operand: this.resolveOperand(node.id, 0) };
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
			case 'gamma':
				// An unnamed gamma reaching here would be a state merge (handled separately by
				// blocksToAST); a NAMED (per-variable) gamma is a pure value merge -- reconstruct it
				// as a ternary, which is exactly what it means.
				return {
					type:		'conditional',
					test:		this.resolveOperand(node.id, 0),
					consequent:	this.resolveOperand(node.id, 1),
					alternate:	this.resolveOperand(node.id, 2),
				};
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
		if (node.type === 'unary') {
			// A prefix ++/-- already performs its own assignment as a side effect when evaluated --
			// printed as a bare expression statement, `++i;` is both correct and sufficient. Routing it
			// through declareOrAssign like an ordinary reassignment would wrap it in a redundant
			// self-assignment: `i = ++i;`.
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
		if ((node.type === 'var' || node.type === 'mu') && typeof node.value === 'string')
			return Identifier(node.value);

		// A theta's exported value IS its mu source's value, unchanged -- it exists only to mark where
		// a loop-carried variable becomes readable again after the loop, not to compute anything itself.
		if (node.type === 'theta' && typeof node.value === 'string')
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
			if (node.type !== 'mu' && node.type !== 'theta' && node.type !== 'var' && node.type !== 'literal') {
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
			// EARLY_RETURN_MARKER, PROGRAM_START, ...), this one DOES need a real printed statement --
			// it's what real JS routes to the nearest enclosing loop/switch at runtime. See BuildVSDG's
			// 'break'/'continue' case for why nothing here needs to track WHICH loop/switch it targets.
			if (node.type === 'effect' && (node.value === 'BREAK_MARKER' || node.value === 'CONTINUE_MARKER')) {
				statements.push({ type: node.value === 'BREAK_MARKER' ? 'break' : 'continue' } as Statement);
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
				statements.push(this.emitNamedSlot(name, node));
				continue;
			}

			switch (node.type) {
				case 'literal':
				case 'var':
				case 'mu':
				case 'theta':
				case 'effect':
					// No statement of their own: literals/vars/mu/theta are read directly by
					// resolveNode, and non-call effect nodes are internal bookkeeping markers
					// (RETURN_ANCHOR/EARLY_RETURN_MARKER) with no source-level representation.
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
	// We are looking for Gamma nodes (Value or State)
	if (node.type !== 'gamma')
		return false;

	// A named (per-variable) gamma has [condition, true, false] at ports 0/1/2; a state-merging gamma
	// has an extra state-predecessor at port 0, shifting those three to ports 1/2/3.
	const port = typeof node.value === 'string' ? 0 : 1;

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

	for (const node of graph.graph.values()) {
		// Skip nodes with side-effects or loop/branch control flow tokens.
		// These are sequence-dependent and cannot be collapsed based purely on data inputs.
		if (['mu', 'theta', 'gamma', 'effect'].includes(node.type))
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
export function applyGlobalCodeMotion(graph: Map<NodeId, Node>) {
	const blockIds		= new Map<NodeId, BlockId>();

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
		} else if ((node.type === 'mu' || node.type === 'theta' || node.type === 'gamma') && typeof node.value !== 'string') {
			// Only the UNNAMED variant of mu/theta/gamma is a real state/control anchor: its inputs[0]
			// is genuinely a state-chain predecessor. The NAMED (per-variable) variant's inputs[0] is
			// just a test/initial VALUE, not state -- treating it as an anchor fed a non-state edge into
			// `blockTree` below, giving it a bogus parent that scheduleLate's walk-to-root loop could
			// never reach 'block_entry' through (spinning forever), or that nothing in blocksToAST's
			// traversal ever actually visits (silently dropping whatever depended on it).
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
		if (node?.type === 'mu' && typeof node.value !== 'string') {
			depth = parentDepth + 1;
		} else if (node?.type === 'theta' && typeof node.value !== 'string') {
			const muBlockId		= rootBlocks.get(node.inputs[0].nodeId); // the state-theta's own mu
			const muParentId	= muBlockId !== undefined ? blockTree.get(muBlockId) : undefined;
			depth = getLoopDepth(muParentId);
		}
		loopDepthMemo.set(blockId, depth);
		return depth;
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
			if (node.type === 'mu' && port === 1)
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
				if (consumerNode.type === 'mu' && consumerEdge.port === 1)
					continue;

				// The exact same structural issue, for if/else: feeding a NAMED (per-variable) gamma's
				// trueVal (port 1) or falseVal (port 2) only means "I'm one of the two alternatives
				// this ternary picks between", not "I must be ready by the gamma's own block" -- the
				// gamma's block sits AFTER both branches, not inside either one, so treating this as an
				// ordinary consumer could produce a latestBlock that isn't even a blockTree descendant
				// of earliestBlock (the branch's own content is a SIBLING of the post-if continuation,
				// not its ancestor), which the walk below has no way to reconcile either.
				if (consumerNode.type === 'gamma' && typeof consumerNode.value === 'string' && consumerEdge.port !== 0)
					continue;

				// Likewise never actually read by codegen -- left as an ordinary constraint, this
				// dragged the OLD value's own declaration/scheduling into wherever the assignment
				// itself happened to live (e.g. into an if-branch it has no real reason to be inside).
				if (consumerNode.isVestigialEdge(consumerEdge.port))
					continue;

				let consumerBlock = blockIds.get(consumerEdge.nodeId)!;

				// Special case: feeding a mu's port 0 (its INITIAL, pre-loop value -- e.g. `let i = 0;` feeding i's mu) belongs to the block *before* the loop, not wherever the mu itself now lives.
				// The pre-header is the immediate dominator sitting right outside the loop structure.
				if (consumerNode.type === 'mu' && consumerEdge.port === 0)
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
	const CONTROL	= new Set(['effect', 'gamma', 'mu', 'theta']);

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
			if (target.type === 'gamma' || target.type === 'mu') {
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

			if (control.type === 'gamma' && typeof control.value !== 'string') {
				// An unnamed gamma anchoring its own block is a STATE merge (an if/else where at least
				// one branch has a side effect) -- named (per-variable) gammas are pure values, never
				// anchor their own block, and are handled by emitLocalStatements instead.
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
					// LOOP ROTATION: the condition is computed using the mu nodes' CURRENT (this
					// iteration's) values, which only exist once we're already inside the loop body --
					// there is no way to compute it "before" a `while (cond) { ... }` header, since the
					// header would need something the body alone provides. `while (cond) { body }` is
					// structurally impossible here; `while (true) { <compute cond>; if (!cond) break; body }`
					// isn't -- it just moves the same condition check to the top of the body instead of
					// the (unavailable) position before it.
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

					statements.push(JS.While(Literal(true), JS.Block(
						...testStatements as JS.Statement<any>[],
						JS.If({ type: 'unary', operator: '!', operand: output.resolveOperand(thetaNode.id, 1) } as Expr,
							JS.Block({ type: 'break' } as JS.Statement<any>)
						) as JS.Statement<any>,
						...restStatements as JS.Statement<any>[],
						...restOfBody as JS.Statement<any>[]
					)) as Statement);
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
