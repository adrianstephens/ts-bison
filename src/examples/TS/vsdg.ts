/* eslint-disable @typescript-eslint/no-this-alias */
import * as JS from './js-parser';
import * as TS from './ts-parser';
import { Identifier, Literal } from '../common';
import { Walkable, walkB, calcUnary, calcBinary, RecurseB, isJsStatement, isTsDeclaration } from './walker';
import { patternBindings as buildPatternBindings } from './transform';

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

// What a node fundamentally IS: its tag plus the one payload that tag carries -- an AST expression
// (floating/mutation/unary_post/.../some effect nodes), a raw statement (passthru/class_decl/a
// top-level function_decl), or a slot name (var/muValue/thetaValue/member/named-except, and the
// bookkeeping tag on most effect markers). A literal has no tag of its own: it's a 'floating' node
// whose expr.type is 'literal'. `.type` is genuinely mutated in place in two spots (foldConstants
// folds a binary/unary into a literal; the arrow/function case retags a function_decl entry to
// effect) -- both are same-payload-shape transitions, done through `retag`.
interface SwitchCase { testNodeId?: NodeId; boundaryId: NodeId; tailId: NodeId }

type INode =
	| { type: 'gamma' }
	// neverMaterialize: a broken-out merge whose operand still resolves to its OWN name would print a
	// circular `name = op0 ? name : name;` -- forces it to always resolve lazily instead.
	| { type: 'gammaValue', neverMaterialize?: boolean }
	// loopKind: a do-while's state mu -- the body runs before the first test, so no loop-rotation.
	| { type: 'mu', loopKind?: 'do' }
	| { type: 'muValue', name: string }
	| { type: 'theta' }
	| { type: 'thetaValue', name: string }
	| { type: 'var', name?: string }
	// switchDiscriminantId/switchCases: a `break_scope` reconstructing a real `switch` -- the
	// discriminant node, and each case's resolved test + body span (see SwitchCase).
	| { type: 'break_scope', switchDiscriminantId?: NodeId, switchCases?: SwitchCase[] }
	// catchParam: the catch clause's binding name, for reconstructing `catch (e) {...}`.
	| { type: 'except', name?: string, catchParam?: string }
	// destructuredParams: maps a destructured param's pattern to the hidden temp its value binds to,
	// so the printed signature and the body agree. stmt: a top-level function_decl's own source node.
	| { type: 'function_decl', stmt?: Statement, destructuredParams?: Map<JS.BindingTarget, string> }
	| { type: 'class_decl', stmt: Statement }
	| { type: 'passthru', stmt: Statement }
	| { type: 'effect', name?: string, expr?: Expr }
	// optional: a `?.` member access (`.name` is the property; unlike 'index', which keeps the whole
	// expr) -- without it `a.b?.c` reconstructs as `a.b.c`.
	| { type: 'member', name: string, optional?: boolean }
	| { type: 'unary_post', expr: Expr }
	| { type: 'unary_post_old', expr: Expr }
	| { type: 'floating', expr: Expr }
	| { type: 'mutation', expr: Expr }
	;

type NodeType = INode['type'];

// The edge machinery every node has, plus the optional annotations the passes stamp on that span
// several tags (or are read cross-tag: returnNodeId is checked on a function_decl entry AND on the
// effect node the arrow/function case retags it into). Tag-local annotations live on the matching
// INode variant instead.
class RawNode {
	inputs:		Edge[]		= [];	// inputs[port] = the single source edge feeding this slot
	outputs:	Edge[][]	= [];	// outputs[port] = every downstream edge consuming this channel
	// Set when this node is the current binding of a real source variable (var_decl/reassignment/
	// ++/--), or a per-variable gammaValue/named-except merge -- tells Output to print it by name
	// instead of an anonymous temp (see slotName).
	boundName?:	string;
	// A var_decl's declaration kind and (paired) type annotation -- threaded through every
	// reconstruction so an explicitly-typed empty-collection literal doesn't lose its type. Read on
	// an un-narrowed node in a few spots (declareOrAssign, reconcileVariables), hence not on 'var'.
	declKind?:	JS.DeclarationKind;
	typeAnnotation?: TS.Type;
	// Forces a reassignment to print even with no value-consumer: one on an exited branch
	// (break/continue/return) skips the post-branch merge entirely, so needsTemp would see it as dead.
	forcedPrint?: boolean;
	// A function/class decl's RETURN_ANCHOR id -- no ordinary edge connects entry to return, and an
	// empty body makes edge-walking alone indistinguishable from "no return node at all". Also read
	// on the effect node an arrow/function expression retags its entry into.
	returnNodeId?: NodeId;
	// The program's own final state-chain node id, stamped once on PROGRAM_START -- the top level
	// has no return anchor the way a function does, so this is the walk's own starting point instead.
	programEndId?: NodeId;
	// Marks switch's own internal bookkeeping (`__hit`/`__matchN`) as always resolved by name --
	// without this it's indistinguishable from an ordinary reassignment, whose inlining legitimately
	// depends on forcedPrint/needsTemp. Set on a gamma AND on the `hit` var/mutation.
	switchInternal?: boolean;
	// A 'this'/'super' node's enclosing function id -- unlike a param (a real graph edge), it has no
	// input to float a hoisted, loop-invariant read against, so without this it can escape the
	// class/function it belongs to entirely.
	scopeAnchorId?: NodeId;
	// Stamped on whatever node an export left behind, so its own print site can wrap it in
	// `export `/`export default `.
	exported?: 'named' | 'default';
	// Marks a var read from a DIFFERENT function than its own declaration -- such a read can't be
	// safely inlined: the reading function may run zero, one, or many times, so it must always
	// re-read the variable by name, never substitute its declaration-time value.
	capturedRead?: boolean;
	// A class anchor's own resolved pieces (heritage, each member's computed key/static value/method
	// body) -- index-aligned with the original `body` array; rebuildClass splices these back in. Set
	// on a class_decl statement AND on the effect node of a class expression.
	classInfo?: ClassInfo;
	// Same as classInfo, for an object literal's own method/get/set properties -- index-aligned with
	// `s.properties`, undefined for a field/spread (which already thread a real value port).
	objectMembers?: (ClassMember | undefined)[];
	// The payload -- redeclared (required, per tag) by the matching INode variant, so a narrowed
	// `Node` drops the `?`, while an un-narrowed one still reads it as `T | undefined`.
	expr?: Expr;
	stmt?: Statement;
	name?: string;
	constructor(public id: string) {}
	outDegree() { return this.outputs.reduce((sum, arr) => sum + arr.length, 0); }
}

// A concrete node: RawNode's edge machinery + annotations, plus one INode variant's own payload.
type Node<N extends INode = INode> = RawNode & N;
// The node for one specific tag, with that variant's own annotations -- what makeNode/retag hand back.
type NodeOf<T extends NodeType> = Node<Extract<INode, { type: T }>>;

function MakeNode<N extends INode>(id: string, inode: N): NodeOf<N['type']> {
	return Object.assign(new RawNode(id), inode) as unknown as NodeOf<N['type']>;
}

// A same-payload-shape tag change (floating literal <- folded binary/unary; effect <- function_decl
// entry). Mutates in place -- other nodes already hold this reference -- and re-narrows the result.
function retag<N extends INode>(node: RawNode, inode: N): NodeOf<N['type']> {
	return Object.assign(node, inode) as unknown as NodeOf<N['type']>;
}

// A node's real source-variable name, if it has one -- a direct rebind or a per-variable merge,
// both via boundName (see rebindVar and the gammaValue/named-except sites, which set it directly).
function slotName(node: RawNode): string | undefined {
	return node.boundName;
}

// 'effect' tags both a real effectful EXPRESSION (expr is set) and an internal bookkeeping marker
// (name is set instead, e.g. MUTATION_MARKER/RETURN_ANCHOR) -- which field is set tells them apart.
function isEffect(node: Node): node is Node<{ type: 'effect', expr: Expr }> {
	return node.type === 'effect' && node.expr !== undefined;
}

// True when an edge into `node` at `port` is wired up generically but never actually read by
// codegen, so it must not count as a real reader for reuse/dead/inline decisions or constrain GCM
// scheduling like an ordinary dependency.
function isVestigialEdge(node: Node, port: number): boolean {
	if (node.type === 'mutation' && node.expr.type === 'binary' && port === 0 && node.expr.operator === '=')
		return true;
	if (node.type === 'thetaValue' && port === 0)
		return true;
	// threadMutation's own ordering-only marker edge (port 2) -- without this, isPureSubgraph's
	// recursion walks into it (an 'effect' node) and wrongly calls the whole subgraph impure.
	if ((node.type === 'var' || node.type === 'mutation') && port === 2)
		return true;
	// A state gamma's tail ports (2/3): Output's emitChain walks these directly to find where
	// each branch's content starts, never through resolveOperand.
	if (node.type === 'gamma' && (port === 2 || port === 3))
		return true;
	// A switchInternal gamma's own condition (port 1): switch's own case-cascade reconstruction
	// bypasses it entirely.
	if (node.type === 'gamma' && node.switchInternal && port === 1)
		return true;
	// A break_scope's tail port (1) -- same reasoning as gamma's.
	if (node.type === 'break_scope' && port === 1)
		return true;
	// A state-merging except's try/catch/finally tails (1/2/3) -- same reasoning. A NAMED
	// except's own value ports (0/1) are never visited this way in the first place.
	return node.type === 'except' && node.name === undefined && (port === 1 || port === 2 || port === 3);
}

function connectValue(
	from:	Node, outputPort: number,
	to:		Node, inputPort: number
): void {
	to.inputs[inputPort] = { nodeId: from.id, port: outputPort };
	(from.outputs[outputPort] ??= []).push({ nodeId: to.id, port: inputPort });
}

// INVARIANT for any "scheduling-only" edge (one added purely to influence GCM's placement of `to`,
// not read by codegen): `from` must be a genuine STRUCTURAL lower bound on `to`'s depth, never
// merely incidental -- scheduleEarly treats it as an ordinary dependency, so an incidental `from`
// can drag an unconditional statement inside a conditional it doesn't belong in.


class Scope {
	local	= new Set<string>;
	bindings = new Map<string, Node>();
	// Set only on a function's own scope (never an ordinary if/while/etc body) -- distinguishes an
	// ordinary local reassignment from one that crosses into an enclosing function (needs
	// forcedPrint, see isLocalToCurrentFunction).
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

	// False means `name` is captured from outside the current function -- reassigning it is an
	// effect that escapes this function, so it can't be safely inlined based on a same-region
	// consumer count (the real consumer may be an as-yet-unrun caller).
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

	// stateAnchor gives a named mu a real scheduling dependency on the loop -- without it, GCM would
	// treat anything depending on the mu as loop-invariant and float it out before the loop entirely.
	// currentFunctionEntry is a live getter, not a captured value: a name looked up from a further
	// nested function needs THAT function's entry, not whichever was current at construction.
	constructor(parent: Scope, public makeNamedNode: (type: NodeType, name: string) => Node, public stateAnchor: Node, public currentFunctionEntry: () => Node | undefined) {
		super(parent);
	}
	public get(name: string): Node | undefined {
		const node = this.bindings.get(name);
		if (node)
			return node;
		const old = this.parent?.get(name);
		if (old) {
			const mu = this.makeNamedNode('muValue', name);
			// A captured (outer-scope) read touched inside a loop needs the same scopeAnchorId floor
			// this/super get: without it, a value purely derived from this mu can be hoisted (loop-
			// invariant) past the arrow/function it's lexically inside, into an enclosing scope that
			// never reads it (a verbatim-printed arrow body is oblivious to anything GCM decided).
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
		// Clears node's OWN inputs too, not just the producers' outputs -- harmless for printing, but
		// a later pass that walks every node's inputs unconditionally (scheduleEarly) would otherwise
		// crash once the now-unreferenced producer is removed by a later CSE pass.
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
	// The innermost function_decl currently being walked (undefined at top level) -- set/restored
	// around buildFunctionBody, so a 'this'/'super' node created anywhere inside gets its own
	// scopeAnchorId.
	let currentFunctionEntry: Node | undefined;

	// Names never declared anywhere in this file (globals, built-ins, imports) -- each gets a
	// single, shared, declKind-less 'var' node so it can be read by name without a declaration.
	const externalNodes = new Map<string, Node>();

	function makeNode<N extends INode>(inode: N): NodeOf<N['type']> {
		const id	= inode.type + String(nextId++);
		const node	= MakeNode(id, inode);
		graph.set(id, node);
		return node;
	}
	// A node whose own payload is just a name: a slot name (var/muValue/thetaValue/gammaValue/
	// named-except/member's property) or an internal bookkeeping tag (most effect nodes).
	function makeNamedNode<T extends NodeType>(type: T, name: string) {
		return makeNode({ type, name } as Extract<INode, { type: T }>);
	}
	// A node whose own payload is a raw statement (passthru/class_decl/a top-level function_decl).
	function makeStmtNode<T extends NodeType>(type: T, stmt: Statement) {
		return makeNode({ type, stmt } as Extract<INode, { type: T }>);
	}
	// Seeds the top-level (and, transitively, each function body's) state chain -- without it, any
	// effect before the first function_decl has nothing valid to thread its first state edge from.
	let end: Node = makeNamedNode('effect', 'PROGRAM_START');
	const programStart = end;

	// True when the path just walked never falls through to its own lexical successor (it broke,
	// continued, or returned) -- consulted by 'if' to decide whether a branch needs a real gamma
	// even with no call in it, and to propagate "exited" to its own enclosing branch.
	let exited = false;

	// True specifically when `exited` was caused by `break`, not continue/return/throw: a break
	// targets real code (an enclosing loop/switch) that reads a reassigned variable back through the
	// graph, so its value must survive into the merge -- the others' targets don't, and threading
	// their value through a graph-level merge too actively confuses GCM's own scheduling.
	let brokeOut = false;

	// One entry per enclosing LOOP (switch is transparent to `continue`): a for-loop's own `update`
	// expression, or undefined for while/do-while. `continue` -- lowered onto the same while-shaped
	// graph while/do-while use -- would otherwise skip `update` entirely, so it re-walks a FRESH
	// clone of it (the original was already walked once, for the normal path).
	const loopUpdateStack: (Expr | undefined)[] = [];

	// 'floating' is the uniform tag for every ordinary, genuinely pure value-producing expression
	// node; an assignment-operator binary or ++/-- unary gets 'mutation' instead, despite sharing
	// the same AST shape -- both carry a real effect and must never be treated as an ordinary
	// poolable value (constant-foldable/CSE-mergeable/freely inlinable) the way 'floating' is.
	function makeExprNode<T extends NodeType = 'floating'>(expr: Expr, type: T = 'floating' as T) {
		const node = makeNode({ type, expr } as Extract<INode, { type: T }>);
		expnodes.set(expr, node);
		return node;
	}
	function getExprNode(expr: Expr) {
		if (expr.type === 'identifier') {
			const found = scope.get(expr.name);
			if (found) {
				// See capturedRead's own comment: a read reaching outside its declaring function must
				// never be statically inlined, since the reading function may run any number of times.
				if (!scope.isLocalToCurrentFunction(expr.name))
					found.capturedRead = true;
				return found;
			}
			let ext = externalNodes.get(expr.name);
			if (!ext) {
				ext = makeNamedNode('var', expr.name);
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


	// Walks the state chain backward from `tail` to `boundary`, ignoring MUTATION_MARKER nodes, to
	// check for a REAL effect (a call) -- used to decide whether an if/else branch needs a
	// structural gamma, or whether its value is already fully captured by a per-variable named one.
	function hasRealEffect(tail: Node, boundary: Node): boolean {
		let cur = tail;
		while (cur !== boundary) {
			if (!(cur.type === 'effect' && cur.name === 'MUTATION_MARKER'))
				return true;
			const pred = cur.inputs[0];
			if (!pred)
				return true; // shouldn't happen; treat conservatively as a real divergence
			cur = graph.get(pred.nodeId)!;
		}
		return false;
	}
	// A reassignment is an observable mutation, like a call, but wasn't threaded through the state
	// chain -- without this, a later read of the same binding could be scheduled as if it ran BEFORE
	// the reassignment. Threads a marker into the chain and hangs the node off it via a scheduling-
	// only edge on its own unused port 2 (binary uses 0/1 for real operands, unary uses only 0).
	// (A tighter, per-prior-effect version was tried and reverted: it also constrains scheduling
	// DEPTH, pulling an unconditional reassignment inside a conditional its target effect happened
	// to be nested in -- `if (i) { g(i); } i = i + 1;` became an infinite loop.)
	function threadMutation(node: Node) {
		const marker = makeNamedNode('effect', 'MUTATION_MARKER');
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

	// Shared by 'while' and 'do_while': same mu/theta machinery, differing only in whether the test
	// is read before the body (while) or after it (do_while -- the body always runs once first).
	function buildLoop(recurse: RecurseB, test: Expr, body: Statement, isDoWhile: boolean, forUpdate?: Expr) {
		const preLoop	= getState();
		const muEnd		= makeNode({ type: 'mu' });
		if (isDoWhile)
			muEnd.loopKind = 'do';
		const muScope	= new ScopeMu(scope, makeNamedNode, muEnd, () => currentFunctionEntry);
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

		const stateTheta = makeNode({ type: 'theta' });
		connectValue(muEnd, 0, stateTheta, 0);		// Slot 0 = State predecessor (the loop)
		connectValue(testNode, 0, stateTheta, 1);	// Slot 1 = Loop termination condition
		end = stateTheta;

		scope = preLoop.scope;
		for (const [name, muNode] of muScope.muNodes) {
			const node = muScope.bindings.get(name)!;
			connectValue(node, 0, muNode, 1);		// Slot 1 = Feedback loop

			const theta = makeNamedNode('thetaValue', name);
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

	// Shared by 'if' and 'switch' (each case is structurally its own binary branch, chained forward
	// into the next): resets scope/end/exited to `parent`, walks one branch, captures the result.
	function walkBranch(parent: State, walk: () => void) {
		setState(new Scope(parent.scope), parent.end);
		walk();
		return getState();
	}

	// The STATE-level half of reconciling two branches: does either side need a real structural
	// gamma (a call, or an exit), or does state continue unchanged past a branch that only
	// reassigned variables. Sets `end`/`exited` for whatever comes next.
	function mergeState(parent: State, test: Node, trueState: State, falseState: State): Node | undefined {
		if (trueState.exited || falseState.exited || hasRealEffect(trueState.end, parent.end) || hasRealEffect(falseState.end, parent.end)) {
			const gamma = makeNode({ type: 'gamma' });
			connectValue(parent.end, 0, gamma, 0);		// Slot 0 = State predecessor
			connectValue(test, 0, gamma, 1);				// Slot 1 = Condition
			connectValue(trueState.end, 0, gamma, 2);		// Slot 2 = True State
			connectValue(falseState.end, 0, gamma, 3);	// Slot 3 = False State
			end = gamma;
			// Only counts as "exited" to whatever encloses it when BOTH sides did -- an implicit
			// empty else always falls through, so the non-existent side already reports exited: false.
			exited = trueState.exited && falseState.exited;
			// Same for brokeOut: mixed exit kinds (one breaks, one returns) fall back to false, same
			// as reconcileVariables's "both exited" case -- nothing downstream is reachable either way.
			brokeOut = exited && trueState.brokeOut && falseState.brokeOut;
			return gamma;
		}
		// No real effect in either branch -- already fully captured by reconcileVariables's own
		// per-variable named gamma. `end` still must reset, or it dangles off whichever branch's
		// mutation-marker chain was walked last instead of the state that actually continues past it.
		end = parent.end;
		exited = trueState.exited && falseState.exited;
		brokeOut = exited && trueState.brokeOut && falseState.brokeOut;
		return undefined;
	}

	// True if `name` is currently loop-carried: a `while`'s next iteration sees the update only
	// through the real runtime variable, unlike a one-shot if/switch merge (no graph edge connects
	// one iteration's value to the next's read). The nearest ScopeMu ancestor always owns it.
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
				// Exactly one branch exited. continue/return/throw: handled entirely by that
				// branch's own forced-printed statement plus JS runtime semantics -- nothing
				// downstream reads this value back through the graph, so merging it here would be
				// wrong (confirmed empirically: corrupts GCM scheduling). break: unlike those, its
				// target (an enclosing loop/switch) DOES read `name` back through the graph, so it
				// falls through to the ordinary gamma-building below.
				const exitedState = trueState.exited ? trueState : falseState;
				if (trueState.exited !== falseState.exited && !exitedState.brokeOut) {
					const exitedVal = trueState.exited ? trueVal : falseVal;
					if (exitedVal.boundName === name)
						exitedVal.forcedPrint = true;
					scope.set(name, trueState.exited ? falseVal : trueVal);
					continue;
				}

				// Each branch's own plain-reassignment node picked up boundName === name while
				// walked as the tentative final answer -- now superseded by the gamma, so it's
				// cleared, EXCEPT the side that broke out (still needs forcedPrint, which requires
				// boundName/slotName to stay set) and a var_decl's own wrapper (declaring `x` is a
				// separate concern from which value merges where).
				const trueExitedViaBreak	= trueState.exited && !falseState.exited && trueState.brokeOut;
				const falseExitedViaBreak	= falseState.exited && !trueState.exited && falseState.brokeOut;

				// forcedPrint is only NECESSARY when `name` is loop-carried -- a one-shot if/switch
				// merge has no next-iteration read needing a real mutated variable, so a graph edge
				// alone is just as correct. switchInternal is the other reason to force it (switch's
				// own `hit = true;` bookkeeping).
				// gammaValue/except are excluded from the "supersede, so clear" branch below: their
				// own boundName is a MERGE identity, not a plain reassignment's -- one of them can
				// itself be an operand here (e.g. a later switch case merging against an earlier
				// case's own __hit merge), and it must keep resolving by name for any FURTHER merge
				// chained off it, unlike a plain reassignment genuinely superseded by this one.
				if (trueExitedViaBreak && trueVal.boundName === name && (trueVal.switchInternal || isLoopCarried(name)))
					trueVal.forcedPrint = true;
				else if (trueVal.boundName === name && !trueVal.declKind && trueVal.type !== 'gammaValue' && trueVal.type !== 'except')
					trueVal.boundName = undefined;

				if (falseExitedViaBreak && falseVal.boundName === name && (falseVal.switchInternal || isLoopCarried(name)))
					falseVal.forcedPrint = true;
				else if (falseVal.boundName === name && !falseVal.declKind && falseVal.type !== 'gammaValue' && falseVal.type !== 'except')
					falseVal.boundName = undefined;

				// When one side broke out, its operand still carries boundName === name -- printing
				// the merge itself under that same name would be circular; neverMaterialize gets the
				// same "never print by this name" outcome directly.
				const gamma = makeNode({ type: 'gammaValue' });
				// Set directly, not via rebindVar: this merge isn't itself a fresh mutation (each
				// branch's own value already threaded its own threadMutation), so it shouldn't get
				// its own MUTATION_MARKER -- only slotName()'s "this node owns printing under a name"
				// signal.
				gamma.boundName = name;
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

	// A method/get/set/static_block's own independent function-scoped subgraph, reusing the same
	// entry/return machinery a top-level function_decl gets. entryNode is connected into the outer
	// state chain not because the body runs at this point (it doesn't, except a static block) but so
	// applyGlobalCodeMotion's own region-boundary logic nests it under the right enclosing region.
	function buildFunctionBody(recurse: RecurseB, params: JS.Params<TS.Type> | undefined, body: Expr | Statement[]): Node {
		const outer			= getState();
		const entryNode		= makeNode({ type: 'function_decl' });
		const returnNode	= makeNamedNode('effect', 'RETURN_ANCHOR');
		entryNode.returnNodeId = returnNode.id;
		connectValue(outer.end, 0, entryNode, 0);

		// Gives the body its own, unambiguous region root for regionRootOf (applyGlobalCodeMotion)
		// to find -- entryNode's own block isn't safe to use for that.
		const bodyStart = makeNamedNode('effect', 'FUNCTION_BODY_START');
		connectValue(entryNode, 0, bodyStart, 0);


		const fnScope = new Scope(scope);
		fnScope.isFunctionBoundary = true;

		// A destructured param's own hidden temp binding is created below like any other param, but
		// its flat var_decls can't be recursed until the function's own state chain is live --
		// collected here, emitted right after setState, before the real body statements.
		const pendingParamPatterns: [JS.BindingTarget, string][] = [];
		if (params) {
			// Wire incoming output ports from the entry node directly to parameter bindings.
			// Each param gets its own node (port 0 = State, so params occupy port index + 1);
			let port = 1;
			function addParam(key: JS.BindingTarget) {
				if (typeof key === 'string') {
					const paramNode = makeNamedNode('var', key);
					connectValue(entryNode, port++, paramNode, 0);
					fnScope.create(key, paramNode);
				} else {
					const tempName = `__destructure${nextId++}`;
					const paramNode = makeNamedNode('var', tempName);
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

		// A 'this'/'super' created anywhere inside gets stamped with the INNERMOST entryNode -- not
		// precisely correct for a nested arrow (real JS shares the enclosing `this`), but still keeps
		// a hoisted this-derived value inside some real function's region instead of the top level.
		const outerFunctionEntry = currentFunctionEntry;
		currentFunctionEntry = entryNode;
		for (const [key, tempName] of pendingParamPatterns)
			for (const stmt of patternBindings('let', key, Identifier(tempName)))
				recurse(stmt, 'statement');
		if (Array.isArray(body)) {
			for (const stmt of body)
				recurse(stmt, 'statement');
			// Left unconnected, matching EARLY_RETURN_MARKER's own "bare `return;`" convention --
			// reconstructFunctionBody omits the trailing statement whenever this port is unconnected.
		} else {
			recurse(body, 'expression');
			connectValue(getExprNode(body), 0, returnNode, 1);
		}
		currentFunctionEntry = outerFunctionEntry;

		connectValue(end, 0, returnNode, 0);

		// Propagates a captured variable's own reassignment back into the caller's bindings so a
		// later read resolves to it by name -- safe since forcedPrint plus scheduleLate's own
		// region-boundary exclusion keep the reassignment printed inside this function.
		fnScope.closeAndFlush();
		setState(outer.scope, outer.end, outer.exited, outer.brokeOut);
		return entryNode;
	}

	// Heritage and every member's own computed key are real expressions that can call out -- resolved
	// through VSDG (not a print-blind generic walk) so a referenced outer variable isn't silently
	// inlined/orphaned away. Each resolved value gets a REAL graph edge into `anchor` (ports 1.., 0
	// being the state predecessor): classInfo's own NodeId references alone are invisible to
	// ordinary consumer counting, so without an edge the value would look unused.
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

				// A computed member key is a real expression, resolved through VSDG like any other and
				// wired into `anchor` at the next free port -- same reasoning as buildClass's own
				// comment above (a phantom, edge-less reference would look unused).
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
							// A static field's initializer runs once, at class-definition time, same as
							// heritage/keys -- resolved and wired into `anchor` at its own port for the same
							// reason (without a real edge, it's a phantom reference that looks unused).
							recurse(m.value, 'expression');
							const valueNode = getExprNode(m.value);
							connectValue(valueNode, 0, anchor, port++);
							return { keyNodeId, valueNodeId: valueNode.id };
						}
						// An INSTANCE field's initializer runs once per `new`, not at class-definition time --
						// threading it into the outer chain directly would wrongly force it into a single,
						// one-time position. Reuses buildFunctionBody wholesale (own entry/return-anchor
						// pair, no params), `m.value` as an expression body -- Output's own
						// resolveFieldInitializer reads the resolved value straight off returnNode's port 1.
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
						end.stmt = s;
					}
					return false;

				case 'return': {
					// The marker carries its value directly at port 1 (unconnected for bare `return;`)
					// rather than through scope -- scope can't represent "hasn't returned yet, keep
					// going". `exited = true` makes 'if' build a real gamma around this path instead, so
					// each return prints itself, in place, with no value-merge needed here at all.
					if (s.argument)
						recurse(s.argument, 'expression');
					const marker = makeNamedNode('effect', 'EARLY_RETURN_MARKER');
					connectEnd(marker);
					if (s.argument)
						connectValue(getExprNode(s.argument), 0, marker, 1);
					exited = true;
					return false;
				}
				case 'throw': {
					// Only an EXPLICIT throw is modeled -- a call inside `try` that might itself throw
					// isn't a control-flow edge to `catch`; real JS's own exception routing handles
					// that at runtime regardless, since nothing here reorders the try body's statements.
					recurse(s.argument, 'expression');
					const marker = makeNamedNode('effect', 'THROW_MARKER');
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
					// No target-tracking needed: just mark `exited` (so enclosing `if`s treat this
					// branch as not falling through) and leave a marker for the literal `break;` to
					// print here -- real JS routes it to the nearest enclosing loop/switch at runtime.
					connectEnd(makeNamedNode('effect', 'BREAK_MARKER'));
					exited = true;
					brokeOut = true;
					return false;
				}
				case 'continue': {
					if (s.label)
						console.log(`not handling labeled continue`);
					// A real `for` loop's `update` still runs on `continue` -- but this is lowered onto
					// the same while-shaped graph `while` uses, where a bare `continue;` would otherwise
					// skip it. Re-walks a FRESH clone of `update` first (switch pushes nothing onto
					// loopUpdateStack, so it's correctly transparent to a `continue` inside a case).
					const forUpdate = loopUpdateStack[loopUpdateStack.length - 1];
					if (forUpdate)
						recurse(structuredClone(forUpdate), 'expression');
					connectEnd(makeNamedNode('effect', 'CONTINUE_MARKER'));
					exited = true;
					return false;
				}
				case 'var_decl': {
					// Each declarator's initializer is walked THEN immediately bound, one at a time --
					// not all-then-all -- since real declarators in one statement bind strictly left to
					// right (`let i = off, e = i + len;` needs `i` already in scope for `e`'s own read).
					for (const v of s.declarations) {
						if (typeof v.name === 'string') {
							if (v.init)
								recurse(v.init, 'expression');
							// A dedicated wrapper node per declared variable, not an alias to the
							// initializer's own node -- otherwise `let x = 5; let y = 5;` would bind both
							// names to the same node, with no way to tell which name to print.
							const varNode = makeNamedNode('var', v.name);
							if (v.init)
								connectValue(getExprNode(v.init), 0, varNode, 0);
							varNode.declKind = s.kind;
							varNode.typeAnnotation = v.typeAnnotation;
							// A declaration is an observable event too, like a reassignment: without this,
							// GCM could schedule `let a = 1;` after code that already reads `a`, since both
							// look like ordinary data to the scheduler otherwise.
							rebindVar(v.name, varNode, true);
						} else if (v.init) {
							// Bind the real initializer to a hidden temp exactly once (patternBindings may
							// read it multiple times, so it must never see an effectful expression
							// directly), then desugar the pattern off that temp -- a nested pattern is
							// handled for free by re-entering this same case for each flattened result.
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
					// `recurse`, not `process`: a bare, non-block consequent (`if (x) let y = 1;`) still
					// needs its own var_decl/if/while dispatch, which `process` alone wouldn't give it.
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
					// `for await...of` needs the async iterator protocol -- `await` has no dedicated
					// case anywhere in this file, so it's left on the same "not attempted" fallback.
					if (s.kind === 'of await') {
						console.log(`not handling for-${s.kind}`);
						return process(s);
					}
					if (s.kind !== 'normal') {
						// Desugars to the real synchronous iterator protocol, reusing buildLoop's
						// existing while-shaped machinery: `const __iterN = iterable[Symbol.iterator]();
						// while (true) { const __rN = __iterN.next(); if (__rN.done) break; binding =
						// __rN.value; body }`. `for...in` reuses the same shape over `Object.keys(iterable)`
						// (own enumerable keys only, not the full prototype-chain walk). No `forUpdate`:
						// an ordinary `continue` already re-runs the advance, same as real for-of.
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
					// Run init once, before the loop, then desugar to `while (test) { body; update; }`,
					// folding `update` into the body's own normal (non-continue) tail.
					if (s.init) {
						if (s.init.type === 'var_decl')
							recurse(s.init, 'statement');
						else
							recurse(s.init, 'expression');
					}
					const test = s.test ?? Literal(true);
					const body = s.update ? JS.Block(s.body, JS.Expression(s.update)) : s.body;
					buildLoop(recurse, test, body, false, s.update);
					return false;
				}

				case 'switch': {
					// Lowered into an ordinary if-cascade -- each case is structurally its own binary
					// branch ("hit or matched" vs "not yet"), chained forward, reusing walkBranch/
					// mergeState/reconcileVariables directly, the same pieces 'if' is built from.

					// Evaluate the discriminant exactly once, into a dedicated wrapper node so every
					// case test reads the same value.
					recurse(s.discriminant, 'expression');
					const discValue = getExprNode(s.discriminant);
					const discNode	= makeNode({ type: 'var' });
					connectValue(discValue, 0, discNode, 0);
					discNode.declKind = 'let';
					const suffix	= discNode.id;
					const discName	= `__disc_${suffix}`;
					discNode.name	= discName;
					// rebindVar (not a bare scope.create) threads discNode into the state chain --
					// without it, `let __disc = ...;` is never scheduled anywhere reachable to print.
					rebindVar(discName, discNode, true);

					// Each case's own test is evaluated EXACTLY ONCE, in source order (a side-effecting
					// test, e.g. `case f():`, must run once each, in order), captured into its own
					// named boolean -- `c.test`'s resolved VSDG node (not the raw source) is what the
					// printed case label later reads, so it reflects VSDG's own resolution.
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

					// A hidden "have we entered some case yet" flag, reassigned like an ordinary
					// variable -- fallthrough across case boundaries just works via the same
					// gamma/mu/theta reassignment-merging any real local uses.
					const hitName = `__hit_${suffix}`;
					recurse(JS.VarDecl('let', JS.Var(hitName, Literal(false))));

					// `default` matches iff none of the OTHER cases' tests matched, independent of its
					// own position, so this is built once from every real case's match flag.
					const realMatches = matchNames.filter((n): n is string => n !== undefined);
					const negateOr = (names: string[]): Expr => names.length === 0
						? Literal(true)
						: {
							type: 'unary', operator: '!',
							operand: names.map((n): Expr => Identifier(n)).reduce((a, b) => ({ type: 'binary', operator: '||', left: a, right: b } as Expr)),
						} as Expr;

					// Each case becomes `if (hit || <own condition>) { hit = true; ...body... }`: once
					// true, `hit` makes every later test irrelevant, giving fallthrough for free.

					// A `break_scope`: a scope `break` exits, with none of a loop's iteration
					// machinery (no mu/theta, no re-entry point) -- a switch shares "break exits me"
					// but not "continue re-enters me" (real JS routes a `continue` inside a case past
					// the switch to whichever loop encloses it; an earlier `while(true){...break;}`
					// wrapping caught it instead, an infinite loop when the discriminant stayed
					// constant). An empty switch has no case body that could ever break, so it's
					// skipped entirely -- also avoids wiring the anchor's own tail to itself.
					if (s.cases.length > 0) {
						// The anchor is created AFTER walking the cases (like a gamma's own predecessor/
						// tail split) -- creating it first would make the first case's own parent.end BE
						// the anchor, so emitChain's backward walk would stop there immediately. A
						// dedicated start marker sits between the real predecessor and the cases' own
						// walk so the first case's own state-gamma (if it needs one) doesn't share
						// break_scope's own predecessor node.
						const predecessor = end;
						const startMarker = makeNamedNode('effect', 'BREAK_SCOPE_START');
						connectEnd(startMarker);
						exited		= false;
						brokeOut	= false;

						// Recorded per case for Output's own emitControlNode to reconstruct a real
						// `switch`/`case` -- see switchCases's own Node comment for boundaryId/testNodeId.
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
								// A real 'binary' '=' node, walked through the same expression hook a
								// user-written `hit = true;` would use -- switchInternal keeps it always
								// resolving by name regardless of forcedPrint/needsTemp, since its own
								// mutation is structurally never printed (see boundaryId above).
								recurse({ type: 'binary', operator: '=', left: Identifier(hitName), right: Literal(true) } as Expr, 'expression');
								scope.get(hitName)!.switchInternal = true;
								bodyBoundary = end;
								for (const stmt of c.consequent)
									recurse(stmt, 'statement');
							});
							const falseState = walkBranch(parent, () => {});
							// Any state gamma mergeState builds here belongs entirely to switch's own
							// internal if-cascade, bypassed completely by switchCases' own print-time
							// reconstruction -- tagged switchInternal so isVestigialEdge excludes its
							// condition edge the same way it excludes an ordinary gamma's tail ports.
							const stateGamma = mergeState(parent, testNode, trueState, falseState);
							if (stateGamma)
								stateGamma.switchInternal = true;
							reconcileVariables(parent, testNode, trueState, falseState);
							switchCaseInfos.push({ testNodeId: caseTestInfo[i].testNodeId, boundaryId: bodyBoundary!.id, tailId: trueState.end.id });
						}
						const tail = end;

						const breakScope = makeNode({ type: 'break_scope' });
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

					// Each branch gets its own dedicated start marker between the shared predecessor
					// and its own walk -- without one, a branch's own first statement needing a real
					// gamma/mu/break_scope/except would share the exact same predecessor as `except`.
					const startMarker = (pred: Node, tag: string) => {
						const marker = makeNamedNode('effect', tag);
						connectValue(pred, 0, marker, 0);
						return marker;
					};

					// Each branch gets TWO nested scopes: an outer one the reconciliation loop reads
					// (matching if/else), and an inner one closeAndFlush()'d first so a `let`/const
					// declared directly in the block/handler body doesn't leak into the outer bindings.
					setState(new Scope(parent.scope), startMarker(parent.end, 'TRY_START'));

					scope = new Scope(scope);
					for (const stmt of s.block)
						recurse(stmt, 'statement');
					scope = scope.closeAndFlush()!;
					const tryState		= getState();

					setState(new Scope(parent.scope), startMarker(parent.end, 'CATCH_START'));
					scope = new Scope(scope);
					// For a destructured catch param, catchParamName is the hidden temp that actually
					// prints in `catch (<here>)`, with the real pattern desugared right after.
					let catchParamName: string | undefined;
					if (typeof s.handlerParam === 'string') {
						catchParamName = s.handlerParam;
						scope.create(catchParamName, makeNamedNode('var', catchParamName));
					} else if (s.handlerParam) {
						catchParamName = `__destructure${nextId++}`;
						scope.create(catchParamName, makeNamedNode('var', catchParamName));
						for (const stmt of patternBindings('let', s.handlerParam, Identifier(catchParamName)))
							recurse(stmt, 'statement');
					}
					for (const stmt of s.handlerBody)
						recurse(stmt, 'statement');
					scope = scope.closeAndFlush()!;
					const catchState	= getState();

					// Unlike an `if`'s gamma, this is never skipped even with no real effect in either
					// branch -- try/catch is observable syntax in its own right, so it always needs a
					// real anchor to reconstruct from.
					const exc = makeNode({ type: 'except' });
					if (catchParamName !== undefined)
						exc.catchParam = catchParamName;
					connectValue(parent.end, 0, exc, 0);
					connectValue(tryState.end, 0, exc, 1);
					connectValue(catchState.end, 0, exc, 2);
					end = exc;

					// Per-variable merges -- mirrors 'if', except neither branch's boundName is ever
					// cleared: there's no printable condition for a ternary, so each branch keeps (and
					// force-prints) its own `x = ...;` under its own name, and the merge just connects
					// both as real dependencies.
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

							const namedExc = makeNamedNode('except', name);
							// Also set directly (not via rebindVar, same reasoning as gammaValue's own
							// construction): this merge isn't itself a fresh mutation.
							namedExc.boundName = name;
							connectValue(tryVal, 0, namedExc, 0);
							connectValue(catchVal, 0, namedExc, 1);
							scope.set(name, namedExc);
						}
					}

					// `finally` runs after the merge, walked like ordinary code (not modeled at the
					// graph level as "runs on every exit path" -- reconstructed as a real `finally`
					// clause, real JS semantics already guarantee that on their own).
					let finallyExited = false;
					let finallyBrokeOut = false;
					if (s.finalizer) {
						end = startMarker(exc, 'FINALLY_START');
						exited = false;
						brokeOut = false;
						// Same reasoning as try/catch's own inner scope: a `let`/const in the finalizer
						// shouldn't leak out, but an ordinary reassignment should still propagate.
						scope = new Scope(scope);
						for (const stmt of s.finalizer)
							recurse(stmt, 'statement');
						scope = scope.closeAndFlush()!;
						finallyExited = exited;
						finallyBrokeOut = brokeOut;
						// Port 3 = finally's own tail, mirroring a gamma's true/false-tail ports.
						connectValue(end, 0, exc, 3);
						end = exc;
					}
					// A return/throw/break/continue inside `finally` itself overrides try/catch, so
					// the WHOLE construct only falls through when finally (if present) does too.
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
					// recursing here (rather than falling to `default:`, whose generic descent ALSO
					// walks s.declaration independently) runs the declaration's own handler exactly
					// once, avoiding a literal duplicate; `exported` is read back at that node's own
					// print site to wrap it in `export `.
					recurse(s.declaration, 'statement');
					if (s.declaration.type === 'var_decl') {
						// `end` here is a MUTATION_MARKER wrapping only the LAST declarator's rebind --
						// wrong for `export const a = 1, b = 2;` (every declarator needs the flag), so
						// each declared name's real node is looked up directly from scope instead.
						for (const v of s.declaration.declarations)
							if (typeof v.name === 'string')
								scope.get(v.name)!.exported = 'named';
					} else {
						end.exported = 'named';
					}
					return false;
				}

				case 'import': {
					// Each bound name (namespace/default/named specifiers) gets its own declKind-less,
					// boundName-less 'var' node (same shape externalNodes uses, so it never gets its
					// own declaration statement -- the import's own passthru node declares it) with a
					// threadMutation anchor right after that passthru, so GCM can never place a read
					// earlier than the import that provides it. A type-only import binds no real
					// runtime value, so it's skipped.
					process(s);
					const node = makeStmtNode('passthru', s);
					connectEnd(node);
					if (!s.typeOnly) {
						const bindImport = (name: string) => {
							const varNode = makeNamedNode('var', name);
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
					// `export default class Foo {...}`/`function f() {...}` -- same double-processing
					// risk and fix as export_decl above. A plain-expression default, or a re-export
					// with no `default` (referencing only already-declared bindings by name), needs no
					// VSDG resolution, so it stays on the generic passthru fallback below.
					if (s.default !== undefined && (isJsStatement(s.default) || isTsDeclaration(s.default))) {
						recurse(s.default, 'statement');
						end.exported = 'default';
						return false;
					}
					process(s);
					connectEnd(makeStmtNode('passthru', s));
					return false;
				}

				case 'class_decl': {
					// Its own dedicated type tag (not a bare 'passthru', which would need a runtime
					// value-shape check to tell "resolved class" from "verbatim") makes "always needs
					// rebuildClass" a property of the node itself. Anchored as a statement, not an
					// 'effect' ('class' the expression uses that), since it produces no value.
					const node = makeStmtNode('class_decl', s);
					node.classInfo = buildClass(recurse, node, s);
					connectEnd(node);
					return false;
				}

				default:	{
					// An unreferenced declaration is otherwise an unanchored island nothing schedules.
					process(s);
					const node = makeStmtNode('passthru', s);
					connectEnd(node);
					return false;
				}
			}
			return process(s);
		},
		// on EXPRESSION
		(s, process, recurse) => {
			// Every case that needs its children processed first calls `process(s)` itself, then
			// returns `false` -- never `break`, or a second implicit `process(s)` walks children
			// twice (a nested call like `f(g())` would compile `g` to run twice).
			switch (s.type) {
				case 'literal':
					// A literal is just a 'floating' node whose expr.type is 'literal' -- no dedicated
					// tag (foldConstants folds a binary/unary into one in place, same shape).
					makeExprNode(s);
					return false;

				case 'identifier':
					return false;

				case 'super':
				case 'this': {
					// Unlike 'identifier', `this`/`super` have no scope lookup -- they need a real node
					// registered here, or any consumer throws "missing node" looking one up.
					// See Node's own scopeAnchorId comment -- without this, a this-derived value GCM
					// forces to materialize has nothing to floor it, escaping its own function/class.
					makeExprNode(s).scopeAnchorId = currentFunctionEntry?.id;
					return false;
				}

				case 'unary': {
					// `await x` shares the plain prefix-unary AST shape with `-x`/`typeof x`, but isn't
					// pure -- structurally identical to 'yield' (its effect sequence position must never
					// be reordered/dropped/duplicated; suspend/resume itself is towasm.ts's job).
					if (s.operator === 'await') {
						process(s);
						const node = makeExprNode(s, 'effect');
						connectEnd(node);
						connectValue(getExprNode(s.operand), 0, node, 1);
						return false;
					}
					process(s);
					const isMutation = s.operator === '++' || s.operator === '--';
					const node = makeExprNode(s as Expr, isMutation ? 'mutation' : 'floating');
					connectValue(getExprNode(s.operand), 0, node, 0);
					if (isMutation) {
						if (s.operand.type === 'identifier') {
							rebindVar(s.operand.name, node);
						} else {
							// A property/index target mutates something outside this pass's own scope
							// tracking -- same reasoning as unary_post's own non-identifier branch below:
							// nothing reads this back through scope, so needsTemp would drop it entirely.
							node.forcedPrint = true;
							threadMutation(node);
						}
					}
					return false;
				}
				case 'unary_post': {
					// The non-null assertion (`expr!`) shares the `unary_post` AST shape with a real
					// mutating postfix `++`/`--`, but has no runtime effect at all -- alias straight
					// through, no new node, no old-value snapshot, no rebind.
					if (s.operator === '!') {
						process(s);
						expnodes.set(s, getExprNode(s.operand));
						return false;
					}
					// Unlike prefix, `i++`/`i--` evaluates to the OLD value -- can't alias to the operand's
					// own node, since that stays reachable by name after the rebind and would silently
					// pick up the NEW value. A dedicated snapshot node, threaded before the rebind, pins
					// both its identity and schedule position to this exact moment.
					process(s);
					const operandNode = getExprNode(s.operand);
					const oldNode = makeExprNode(s, 'unary_post_old');
					connectValue(operandNode, 0, oldNode, 0);
					threadMutation(oldNode);
					if (s.operand.type === 'identifier') {
						const node = makeNode({ type: 'unary_post', expr: s });
						connectValue(operandNode, 0, node, 0);
						rebindVar(s.operand.name, node);
					} else {
						// A property/index target mutates something outside this pass's own scope
						// tracking, with no name to rebind -- oldNode's own "materialize only if read"
						// rule covers the snapshot, but says nothing about the mutation ITSELF still
						// needing to run, so it gets its own forced anchor too.
						const node = makeNode({ type: 'unary_post', expr: s });
						connectValue(operandNode, 0, node, 0);
						node.forcedPrint = true;
						threadMutation(node);
					}
					return false;
				}
				case 'binary': {
					process(s);
					const isMutation = ASSIGN_OPS.has(s.operator);
					const node = makeExprNode(s as Expr, isMutation ? 'mutation' : 'floating');
					connectValue(getExprNode(s.left), 0, node, 0);
					connectValue(getExprNode(s.right), 0, node, 1);
					if (isMutation) {
						if (s.left.type === 'identifier') {
							// Reassigning a variable CAPTURED from an enclosing function is an effect
							// that escapes this function -- its real consumer may be a not-yet-run
							// caller, so a same-region consumer count can't decide it's dead/inlinable.
							if (!scope.isLocalToCurrentFunction(s.left.name))
								node.forcedPrint = true;
							rebindVar(s.left.name, node);
						} else {
							// A property/index assignment mutates something outside this pass's scope
							// tracking -- threadMutation anchors it (no name to bind); forcedPrint keeps
							// it printing regardless of consumer count, since nothing reads it back
							// through scope the way a bound variable would.
							node.forcedPrint = true;
							threadMutation(node);
						}
					}
					return false;
				}

				case 'call': {
					// 1. Thread the State Edge to preserve sequence
					process(s);
					// TEMPORARY placeholder for real purity analysis: a callee name starting with
					// "pure" is treated as pure for testing, nothing to do with actual purity.
					const pure = s.callee.type === 'identifier' && s.callee.name.startsWith('pure');
					const node = pure ? makeExprNode(s) : makeExprNode(s, 'effect');
					if (!pure)
						connectEnd(node); // Slot 0 = Input State

					// 2. Thread Value Edges for the function arguments
					s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));

					// The callee prints verbatim, unresolved -- but a bare identifier callee still needs
					// a real graph edge, purely so hasRealConsumer sees it: without one, `const g =
					// makeThing(); g();` looks like `g` is never read, and gets dropped as dead.
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
					// Treated as an effect, like an impure call -- the only thing that matters here is
					// that a yield never gets reordered relative to other effects (state-chain threading
					// already guarantees that); suspend/resume itself is towasm.ts's own job.
					process(s);
					const node = makeExprNode(s, 'effect');
					connectEnd(node);
					if (s.operand)
						connectValue(getExprNode(s.operand), 0, node, 1);
					return false;
				}

				case 'tagged_template': {
					// Desugars to calling `tag` with a strings array plus each interpolated expression --
					// effectful like an ordinary impure call. Only the interpolated `.exp`s need
					// threading; the literal string parts carry through in node.expr unchanged.
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
					// the heritage clause, can call out) -- always order-anchored, like 'new'. No
					// `process(s)`: that would double-walk the same pieces buildClass already does.
					const node = makeExprNode(s, 'effect');
					node.classInfo = buildClass(recurse, node, s);
					connectEnd(node);
					return false;
				}

				case 'jsx': {
					// Desugars to a factory call at runtime -- effectful for the same reason 'call' is.
					// `name` and each attribute's own key are compile-time metadata, unchanged.
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
					// Retag to 'effect' (not buildFunctionBody's own 'function_decl') so isEffect treats
					// this as a printable value, via buildEffectExpr's own 'arrow'/'function' case (prints
					// `.expr` verbatim). expnodes.set lets a later getExprNode(s) find this node.
					const entry = retag(buildFunctionBody(recurse, s, s.body), { type: 'effect', expr: s });
					expnodes.set(s, entry);
					// `entry`, not outer.end: evaluating a function expression (closure creation) is
					// itself an observable, ordered event, so whatever comes next must chain from it.
					const state = getState();
					setState(state.scope, entry, state.exited, state.brokeOut);
					return false;
				}

				case 'member': {
					process(s);
					const node = makeNamedNode('member', s.property);
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
					// A field/spread property threads a real value port, index-matched against
					// s.properties. A method/get/set gets its own function-scoped subgraph (entryNodeId,
					// no graph edge of its own -- see buildClass) stored on objectMembers instead --
					// invisible to a generic graph walk like isPureSubgraph, so any object literal with
					// a method is tagged 'effect' unconditionally, like a class expression, so it's never
					// treated as freely inlinable/duplicable the way an ordinary pure value safely is.
					const hasMethod = s.properties.some(p => p.type === 'method' || p.type === 'get' || p.type === 'set');
					const node = hasMethod ? makeExprNode(s, 'effect') : makeExprNode(s);
					if (hasMethod)
						connectEnd(node);
					s.properties.forEach((prop, index) => {
						if (prop.type === 'spread') {
							recurse(prop.operand);
							connectValue(getExprNode(prop.operand), 0, node, index);
							return;
						}
						if (prop.type === 'method' || prop.type === 'get' || prop.type === 'set') {
							if (typeof prop.key !== 'string') {
								console.log(`not handling computed object key`);
								return;
							}
							if (!prop.body) {
								console.log(`not handling object property ${prop.type} with no body`);
								return;
							}
							(node.objectMembers ??= [])[index] = { entryNodeId: buildFunctionBody(recurse, prop, prop.body).id };
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
					// `(a, b, c)` evaluates all three in order but its own value is only the last --
					// without registering that, reading the sequence's own result throws "missing node".
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


// Desugars a destructuring BindingTarget into flat var_decls reading off valueExpr -- which MUST
// already be a stable, side-effect-free reference, never the raw initializer (a pattern reads its
// value multiple times). Reuses transform.ts's own version (shared with towasm.ts) rather than a
// second copy; wrapped in try/catch since it hard-throws on two gaps (object rest, computed key)
// this file otherwise degrades gracefully on -- accepted since both are already rare.
function patternBindings(kind: JS.DeclarationKind, target: JS.BindingTarget, valueExpr: Expr): Statement[] {
	try {
		return buildPatternBindings(kind, target, valueExpr);
	} catch (e) {
		console.log(`not handling destructuring pattern: ${e}`);
		return [];
	}
}


// A real source-level name is only unique WITHIN its own function -- a flat Set can't tell that
// apart from two unrelated functions declaring the same name, printing the second as a bare,
// undeclared reassignment (a guaranteed ReferenceError). A stack of frames (one pushed per function
// body) fixes this while still resolving a genuinely CAPTURED variable: `has` walks the whole stack
// outward, `add` only ever writes to the innermost frame.
class ScopedNames {
	private stack = [new Set()];
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

export function BuildProgram(
	graph: Map<NodeId, Node>,
	blockIds?: Map<NodeId, BlockId>,
	blockControl?: Map<BlockId, NodeId>,
	getLoopDepth?: (blockId?: BlockId) => number,
) {
	const nodeVariableNames	= new Map<NodeId, string>();
	const declaredNames		= new ScopedNames();
	let tempVarCounter		= 0;

	// blockIds/blockControl/getLoopDepth are GCM's own output (applyGlobalCodeMotion) -- all
	// undefined for a caller with no GCM pass behind it; only buildProgram/emitChain/needsTemp's own
	// loop-invariant check need them, and each degrades gracefully without a real schedule.
	let blockNodesCache: Map<BlockId, NodeId[]> | undefined;

	// The whole program's statement list, walked backward from programEndId down to PROGRAM_START.
	// 'block_entry' is GCM's own well-known id for PROGRAM_START; without blockControl, it's found
	// the same way buildBlockTree itself does -- by type and value -- so this works with no GCM at all.
	const programStartId = blockControl?.get('block_entry')
		?? [...graph.values()].find(n => n.type === 'effect' && n.name === 'PROGRAM_START')?.id;
	if (!programStartId)
		return [];
	const programStart = graph.get(programStartId)!;
	return [...emitControlNode(programStart), ...emitChain(programStart.programEndId, programStartId)];

	function makeTempVar(id: NodeId) {
		const varName = `t${tempVarCounter++}`;
		nodeVariableNames.set(id, varName);
		return varName;
	}

	// True if `node`'s own value has at least one real reader, beyond whatever vestigial edges exist.
	// Zero means it's genuinely dead -- e.g. every branch unconditionally reassigns a variable before
	// anything reads its declared value.
	function hasRealConsumer(node: Node): boolean {
		return (node.outputs[0] ?? []).some(e => !isVestigialEdge(graph.get(e.nodeId)!, e.port));
	}

	// True if `edge` is a gammaValue's own condition port (0) where both branches resolve to the
	// exact same name (buildExpr's own "cond ? x : x" collapse) -- switchInternal, stamped only on
	// switch's own `hit` reassignment, is the reliable signal, since its merge always collapses this
	// way. Counting it as a real consumer would materialize a needless temp.
	function isCollapsingGammaValueCondition(edge: Edge): boolean {
		if (edge.port !== 0)
			return false;
		const target = graph.get(edge.nodeId)!;
		return target.type === 'gammaValue' && !!(
				(target.inputs[1] && graph.get(target.inputs[1].nodeId))?.switchInternal
			||	(target.inputs[2] && graph.get(target.inputs[2].nodeId))?.switchInternal
		);
	}

	function valueConsumers(node: Node): Edge[] {
		const CONTROL = new Set(['effect', 'gamma', 'gammaValue', 'mu', 'muValue', 'theta', 'thetaValue', 'break_scope', 'except', 'function_decl', 'passthru', 'class_decl']);
		return (node.outputs[0] ?? []).filter(e => {
			const target = graph.get(e.nodeId)!;
			if (CONTROL.has(target.type) && e.port === 0)
				return false;
			// A mu's feedback port (1) is as much a scheduling-only edge as its predecessor port (0)
			// -- never a real value read.
			if ((target.type === 'mu' || target.type === 'muValue') && e.port === 1)
				return false;
			if (isVestigialEdge(target, e.port))
				return false;
			if (isCollapsingGammaValueCondition(e))
				return false;
			// A var_decl target that will itself print bare never actually surfaces this value
			// anywhere -- `let x = f();` where x is dead becomes a standalone `f();` instead.
			if (target.type === 'var' && !hasRealConsumer(target))
				return false;
			return true;
		});
	}

	// A pure value only needs its own `const tN = ...;` if it's genuinely REUSED (more than one
	// consumer) -- a single consumer can always resolve it lazily and inline it on demand instead,
	// since recomputing a pure expression is valid anywhere its own inputs are.
	// `allowReuse`, when true, exempts only the final "reused, so give it a name" heuristic below --
	// never the structural checks above it, which are about correctness, not readability. Used by
	// isInlinableVarDecl for a literal initializer: duplicating a literal is free, so multiple
	// readers alone shouldn't force a name -- but one feeding a mu's own initial-value port still
	// needs a real, mutable variable for the loop to advance.
	function needsTemp(node: Node, allowReuse = false): boolean {
		// A named theta's own condition edge is real in the graph but never read by codegen -- a
		// while loop's test feeds every loop-carried variable's own theta condition port, so left
		// uncounted a loop with two such variables would see the test as falsely "reused".
		const consumers = (node.outputs[0] ?? []).filter(e => !isVestigialEdge(graph.get(e.nodeId)!, e.port) && !isCollapsingGammaValueCondition(e));
		// A member-access callee (`obj.method`) must NEVER materialize as a standalone temp --
		// extracting it loses its receiver (`var t0 = update; t0(x);` calls with `this` undefined).
		if (node.type === 'member' && consumers.some(e => isCalleeEdge(graph.get(e.nodeId)!, e.port)))
			return false;
		// A mu/muValue's own initial-value/feedback port, or a rebind's own "old value" port, both
		// need the producer addressable by name regardless of reuse count (see mustNameOwnValue).
		if (consumers.some(e => mustNameOwnValue(graph.get(e.nodeId)!, e.port)))
			return true;
		// A postfix ++/--'s captured old-value snapshot exists solely to freeze the value before the
		// increment -- inlining it at a later consumer would read the wrong, already-mutated value.
		if (node.type === 'unary_post_old')
			return consumers.length > 0;
		// A value GCM scheduled SHALLOWER than one of its own real consumers is loop-invariant
		// relative to it (e.g. `a * b` where neither operand is ever reassigned) -- inlining it at
		// the consumer's own position would silently recompute it every iteration, discarding the
		// whole point of hoisting it. No-ops gracefully without a real GCM schedule.
		if (blockIds && getLoopDepth) {
			const ownDepth = getLoopDepth(blockIds.get(node.id));
			if (consumers.some(e => getLoopDepth!(blockIds!.get(e.nodeId)) > ownDepth))
				return true;
		}
		return !allowReuse && consumers.length > 1;

		// True when `consumer` reads its own producer, at `port`, as a call/new's own CALLEE -- the
		// same port convention BuildVSDG's own 'call'/'new' cases use.
		function isCalleeEdge(consumer: Node, port: number): boolean {
			if (!isEffect(consumer))
				return false;
			const v = consumer.expr as { type?: string; arguments?: unknown[] };
			return (v.type === 'call' || v.type === 'new') && port === (v.arguments?.length ?? 0) + 1;
		}

		// True when `consumer` reads its producer at `port` in a way that requires it addressable BY
		// NAME regardless of reuse count: a mu/muValue's own initial-value/feedback port (never read
		// via resolveNode, so the producer must be a real statement or `i = i + 1;` vanishes), or a
		// rebind's own "old value" port (inlining it would turn a real mutation into a no-op recompute).
		function mustNameOwnValue(consumer: Node, port: number): boolean {
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
	function isInlinableSlot(node: Node): boolean {
		return ((node.type === 'mutation' && node.expr.type === 'binary') || node.type === 'gammaValue')
			&& !node.forcedPrint
			&& ((node.type === 'gammaValue' && node.neverMaterialize) || !needsTemp(node));
	}

	// A destructured param prints as its own hidden temp name in the SIGNATURE too, not just the
	// body -- see destructuredParams. A no-op when this entry has no destructured params at all.
	function rebuildParams<T extends { params: JS.Param<any>[]; rest?: JS.Rest<any> }>(raw: T, entryNode: NodeOf<'function_decl'>): T {
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
	function rebuildClass(raw: any, info: NonNullable<Node['classInfo']>): any {
		return {
			...raw,
			superClass: info.superClassNodeId ? resolveNode(info.superClassNodeId) : raw.superClass,
			body: raw.body.map((m: any, i: number) => {
				const mi = info.members[i];
				if (!mi)
					return m;
				const withKey = mi.keyNodeId ? { ...m, key: { computed: resolveNode(mi.keyNodeId) } } : m;
				if (mi.valueNodeId)
					return { ...withKey, value: resolveNode(mi.valueNodeId) };
				if (m.type === 'field')
					return mi.entryNodeId
						? { ...withKey, value: resolveFieldInitializer(graph.get(mi.entryNodeId)!) }
						: withKey;
				if (!mi.entryNodeId)
					return withKey;
				const entryNode = graph.get(mi.entryNodeId)! as NodeOf<'function_decl'>;
				return { ...rebuildParams(withKey, entryNode), body: reconstructFunctionBody(entryNode) };
			}),
		};
	}

	// Shared by buildExpr's own 'floating' case (a field-only object literal) and buildEffectExpr
	// (a method/get/set-bearing one, see BuildVSDG's own 'object' case for why that's tagged
	// 'effect') -- the reconstruction itself doesn't care which tag got it here, only whether
	// objectMembers has a resolved method body for this particular property.
	function buildObjectExpr(node: Node, expr: Expr & {type: 'object'}): Expr {
		return {
			...expr,
			properties: expr.properties.map((prop, i) => {
				if (prop.type === 'spread')
					return { ...prop, operand: resolveOperand(node.id, i) };
				const mi = node.objectMembers?.[i];
				if (mi?.entryNodeId)
					return { ...prop, body: reconstructFunctionBody(graph.get(mi.entryNodeId)!) as JS.Statement<TS.Type>[] };
				return prop.type === 'field' && typeof prop.key === 'string' ? { ...prop, value: resolveOperand(node.id, i) } : prop;
			}),
		};
	}

	function buildEffectExpr(node: Node<{ type: 'effect', expr: Expr }>): Expr {
		const value = node.expr;
		switch (value.type) {
			case 'arrow': case 'function':
				// GCM never moves anything into or out of a function/arrow body (an isolated
				// sub-region, its own entry/return-anchor pair) -- node.expr is still the original,
				// untouched AST, safe to print verbatim.
				return value;
			// `await x` -- always has a real operand (unlike 'yield', which can be bare).
			case 'unary':
				return { ...value, operand: resolveOperand(node.id, 1) };
			// A method/get/set-bearing object literal -- reconstructed via the same shared helper a
			// field-only one uses; objectMembers is what needs the graph, not the tag itself.
			case 'object':
				return buildObjectExpr(node, value);
			case 'yield':
				return { ...value, operand: value.operand ? resolveOperand(node.id, 1) : undefined };
			case 'tagged_template':
				return { ...value, quasi: value.quasi.map((part, i) => part.exp ? { ...part, exp: resolveOperand(node.id, i + 1) } : part) };
			case 'class':
				return node.classInfo ? rebuildClass(value, node.classInfo) : value;
			case 'jsx': {
				let port = 1;
				return {
					...value,
					attributes: value.attributes.map(a => a.value ? { ...a, value: resolveOperand(node.id, port++) } : a),
					children: value.children.map(() => resolveOperand(node.id, port++)),
				};
			}
			case 'call': case 'new': {
				// A call/new's own callee is normally left raw, unresolved -- wrong only when it embeds
				// a real effect (e.g. `new Point(3,4).sum()`), since the graph also threads that effect
				// into the state chain as its own node, and printing raw source there would duplicate
				// its execution. Reuses the same edge added for consumer-counting (BuildVSDG's own
				// 'call'/'new' cases) rather than a second way to reach the callee's node.
				const calleeEdge = node.inputs[value.arguments.length + 1];
				const calleeNode = calleeEdge && graph.get(calleeEdge.nodeId);
				// A PURE callee can still have been forced to materialize as its own named temp (e.g.
				// hoisted loop-invariant) -- printing value.callee verbatim would duplicate the raw
				// source instead of referencing that temp, discarding the point of hoisting it.
				const calleeTemp = calleeNode && nodeVariableNames.get(calleeNode.id);
				const callee = calleeTemp ? Identifier(calleeTemp)
					: calleeNode && !isPureSubgraph(calleeNode) ? resolveNode(calleeNode.id) : value.callee;
				return { ...value, callee, arguments: value.arguments.map((_, i) => resolveOperand(node.id, i + 1)) };
			}
			default:
				return value;	// can't get here
		}
	}

	// Shared by 'floating''s own 'conditional' case and the outer 'gammaValue' case -- a gammaValue is
	// a per-variable value merge, reconstructed as a ternary (exactly what it means), the same shape
	// a real conditional expression already is; the state gamma itself never reaches here at all
	// (reconstructed separately, by emitControlNode's own 'gamma' case, as a real if/else).
	function buildConditional(node: Node): Expr {
		const consequent	= resolveOperand(node.id, 1);
		const alternate		= resolveOperand(node.id, 2);
		// Both operands can genuinely resolve to the SAME bare name (e.g. a broken-out merge, see
		// reconcileVariables's own neverMaterialize case) -- `cond ? x : x` always just equals `x`.
		if (consequent.type === 'identifier' && alternate.type === 'identifier' && consequent.name === alternate.name)
			return consequent;
		return { type: 'conditional', test: resolveOperand(node.id, 0), consequent, alternate };
	}

	function buildExpr(node: Node): Expr {
		switch (node.type) {
			case 'unary_post':
				return { ...(node.expr as Expr & {type: 'unary_post'}), operand: resolveTarget(node.id, 0) };
			case 'unary_post_old':
				return resolveTarget(node.id, 0);
			case 'member':
				return JS.Member(resolveOperand(node.id, 0), node.name, node.optional);
			case 'gammaValue':
				return buildConditional(node);

			// Every ordinary, genuinely pure value-producing expression shares this one tag -- see
			// makeExprNode's own comment -- so node.expr's own .type picks the shape here.
			case 'floating': {
				const expr = node.expr;
				switch (expr.type) {
					case 'literal':
					case 'this':
					case 'super':
						return expr;
					case 'unary':
						return { ...expr, operand: resolveOperand(node.id, 0) };
					case 'array':
						return { ...expr, elements: expr.elements.map((elem, i) => elem ? resolveOperand(node.id, i) : elem) };
					case 'object':
						return buildObjectExpr(node, expr);
					case 'spread':
						return { ...expr, operand: resolveOperand(node.id, 0) };
					case 'binary':
						return { ...expr, left: resolveOperand(node.id, 0), right: resolveOperand(node.id, 1) };
					case 'conditional':
						return buildConditional(node);
					case 'index':
						return { ...expr, object: resolveOperand(node.id, 0), property: resolveOperand(node.id, 1) };
					case 'call':
						return { ...expr, arguments: expr.arguments.map((_, i) => resolveOperand(node.id, i + 1)) };
				}
				break;
			}

			// A 'mutation' node reaching here as a VALUE means it was superseded by an if/else merge
			// (e.g. `y = (x = 1)`) rather than printed as its own statement -- what's needed is just
			// the value produced. Resolves via resolveTarget, not resolveOperand: a member/index
			// target's value can genuinely differ once the mutation runs, so it must rebuild fresh.
			case 'mutation': {
				const expr = node.expr;
				switch (expr.type) {
					case 'unary':
						return { ...expr, operand: resolveTarget(node.id, 0) };
					case 'binary': {
						const right = resolveOperand(node.id, 1);
						return expr.operator === '='
							? right
							: { type: 'binary', operator: expr.operator.slice(0, -1) as JS.binaryOps, left: resolveTarget(node.id, 0), right };
					}
				}
				break;
			}

			case 'effect':
				// Reaching here means an inlinable effectful call was left unmaterialized and its sole
				// consumer is now resolving it directly -- other 'effect' nodes (markers) are never
				// resolved as a value, so isEffect's guard should always hold here.
				if (isEffect(node))
					return buildEffectExpr(node);
				break;
		}
		console.log(`not handling value node ${node.type}`);
		return Literal(null);
	}

	// Emits either the FIRST declaration of a real source variable (once) or a plain reassignment
	// (every time after) -- only a var_decl's own node ever carries a declKind.
	function declareOrAssign(name: string, node: Node, expr: Expr): Statement {
		if (node.declKind && !declaredNames.has(name)) {
			declaredNames.add(name);
			return JS.VarDecl(node.declKind, JS.Var(name, expr, node.typeAnnotation)) as Statement;
		}
		declaredNames.add(name);
		return JS.Expression({ type: 'binary', operator: '=', left: Identifier(name), right: expr } as Expr) as Statement;
	}

	// A local declaration's initializer needs no printed value when nothing genuinely needs it under
	// x's own name: either it's truly dead, or its one real reader can just recompute the pure
	// initializer inline. Only safe when pure -- an effectful initializer with a real reader must
	// still run at its declared position. capturedRead overrides this: "safe to recompute inline"
	// only holds within a single execution, which a cross-function read isn't.
	function isInlinableVarDecl(node: Node): boolean {
		// declKind, not just node.type === 'var': a PARAM is ALSO a bare 'var' node (inputs[0] wired
		// to the function's entry node, structural plumbing, not a real initializer to recompute) --
		// already handled elsewhere via resolveNode's own no-declKind "read by name" case.
		if (node.type !== 'var' || !node.inputs[0] || node.capturedRead || node.declKind === undefined)
			return false;
		// needsTemp's "reused more than once" heuristic avoids recomputing an expensive expression --
		// not needed for a bare literal, which costs nothing to duplicate. allowReuse (only for a
		// literal initializer) exempts just that heuristic; needsTemp's structural checks (a mu's
		// initial-value port needing a real mutable variable, chief among them) stay in force.
		return !needsTemp(node, isLiteralNode(graph.get(node.inputs[0].nodeId)!));
	}

	// Conservative, single-pass purity check over `node`'s own transitive inputs: true only if NO
	// effect (call) appears anywhere in the subgraph that produces it.
	function isPureSubgraph(node: Node, seen = new Set<NodeId>()): boolean {
		if (seen.has(node.id))
			return true;
		seen.add(node.id);
		if (node.type === 'effect')
			return false;
		// A method/get/set/static_block's own entry node has NO input edges at all (deliberately
		// disconnected from the outer state chain) -- without this check, an empty `.every(...)` is
		// vacuously "pure", wrongly inlining the entry node itself in place of a param's own value.
		if (node.type === 'function_decl')
			return false;
		// A PARAMETER's own value is always pure regardless of what's behind it -- recursing past it
		// into the entry node would poison every computation that merely reads a param's value based
		// on whatever runs before this function is even called.
		if (node.type === 'var' && node.inputs[0] && graph.get(node.inputs[0].nodeId)!.type === 'function_decl')
			return true;
		// Skip vestigial edges (e.g. threadMutation's own scheduling-only marker) -- a real graph
		// edge GCM needs, but never part of the actual value computation.
		return node.inputs.every((e, port) => !e || isVestigialEdge(node, port) || isPureSubgraph(graph.get(e.nodeId)!, seen));
	}

	// True if some node OTHER than `excludeId` shares `name` as its own boundName and is
	// forcedPrint -- will print its own `name = ...;` regardless of what THIS node's consumer count
	// says, so dropping the original declaration would leave that later assignment referencing an
	// undeclared name. A graph-wide scan (small in practice) is the only way to know, since
	// forcedPrint is finalized during BuildVSDG, well before this print-time reasoning runs.
	function hasForcedSibling(name: string, excludeId: NodeId): boolean {
		for (const other of graph.values()) {
			if (other.id !== excludeId && other.boundName === name && other.forcedPrint)
				return true;
		}
		return false;
	}

	function emitNamedSlot(name: string, node: Node): Statement | undefined {
		if (node.type === 'var') {
			if (node.inputs[0]) {
				// Either the initializer is pure and doesn't need printing under x's own name, or x's
				// value is dead outright -- an effectful dead initializer still runs (materialized
				// separately via the ordinary isEffect path), just not attached to x.
				if (node.declKind && (isInlinableVarDecl(node) || !hasRealConsumer(node))) {
					const forcedElsewhere = hasForcedSibling(name, node.id);
					// A forced sibling still needs `name` to hold the CORRECT value when read -- if
					// real consumers exist here too (isInlinableVarDecl via literal-duplication, not
					// dead), a bare declaration would silently replace those reads' value with
					// `undefined`, so fall back to the ordinary, value-bearing declaration instead.
					// declaredNames deliberately NOT set before this call -- declareOrAssign needs to
					// see it as not-yet-declared, to print `let name = ...;` not a bare reassignment.
					if (forcedElsewhere && hasRealConsumer(node))
						return declareOrAssign(name, node, resolveOperand(node.id, 0));
					declaredNames.add(name);
					// Safe to drop entirely only when nothing else still needs `x` declared; exported
					// bindings keep it too (external code may import it by name).
					if (!node.exported && !forcedElsewhere)
						return undefined;
					// `const` requires an initializer -- downgraded to `let` rather than the
					// syntax-invalid `const x;`.
					return JS.VarDecl(node.declKind === 'const' ? 'let' : node.declKind, JS.Var(name, undefined, node.typeAnnotation)) as Statement;
				}
				return declareOrAssign(name, node, resolveOperand(node.id, 0));
			}
			declaredNames.add(name);
			return JS.VarDecl(node.declKind ?? 'let', JS.Var(name, undefined, node.typeAnnotation)) as Statement;
		}
		if ((node.type === 'mutation' && node.expr.type === 'unary') || node.type === 'unary_post') {
			// A prefix or postfix ++/-- already performs its own assignment as a side effect when
			// evaluated -- printed as a bare expression statement, `++i;`/`i++;` is both correct and
			// sufficient. Routing it through declareOrAssign like an ordinary reassignment would wrap
			// it in a redundant self-assignment: `i = ++i;`/`i = i++;`.
			declaredNames.add(name);
			return JS.Expression(buildExpr(node)) as Statement;
		}
		return declareOrAssign(name, node, buildExpr(node));
	}

	function resolveOperand(to: NodeId, slot: number): Expr {
		const edge = graph.get(to)!.inputs[slot];
		if (!edge)
			throw new Error(`Missing operand edge for slot ${slot} on node ${to}`);
		return resolveNode(edge.nodeId);
	}

	// A mutation TARGET (`obj.prop`/`arr[i]`) must always reconstruct fresh from the graph rather
	// than go through resolveNode's "already materialized, trust the name" path: the object/property
	// this addresses can hold a DIFFERENT value once the mutation runs, so a cached temp would name
	// the wrong thing. Only 'member'/index-shaped operands have this hazard; every other shape
	// (identifier var, muValue, literal) resolves by name/value already, so it keeps resolveNode.
	function resolveTarget(to: NodeId, slot: number): Expr {
		const edge = graph.get(to)!.inputs[slot];
		if (!edge)
			throw new Error(`Missing operand edge for slot ${slot} on node ${to}`);
		const opNode = graph.get(edge.nodeId)!;
		return opNode.type === 'member' || (opNode.type === 'floating' && opNode.expr!.type === 'index')
			? buildExpr(opNode) : resolveNode(opNode.id);
	}

	function resolveNode(id: NodeId): Expr {
		const node = graph.get(id)!;

		// switch's own internal bookkeeping must always resolve by name, regardless of forcedPrint/
		// needsTemp -- its own mutation is structurally never printed, so folding its value into a
		// ternary elsewhere would wrongly model a "did this already happen" merge for a flag meant to
		// stay independent at every read site.
		const switchInternalName = node.switchInternal ? slotName(node) : undefined;
		if (switchInternalName !== undefined)
			return Identifier(switchInternalName);

		switch (node.type) {
			// A local declaration left bare (see isInlinableVarDecl) never actually assigned its name --
			// its sole reader inlines the pure initializer directly. Skipped when a forced sibling
			// exists: some other node already resolves via Identifier(name), and inlining here too
			// would break a merge combining them (losing buildExpr's "cond ? x : x -> x" collapse).
			case 'var':
				if (isInlinableVarDecl(node) && !(node.name !== undefined && hasForcedSibling(node.name, node.id)))
					return resolveOperand(id, 0);
				// A param (no declKind) is always safe to trust by name. A genuine local declaration
				// falls back to rebuilding the initializer inline if declaredNames doesn't confirm it
				// was actually printed -- safe since a bare 'var' read always means THIS declaration's
				// own initializer, never a value a later reassignment produced.
				if (node.name !== undefined) {
					if (!node.declKind || declaredNames.has(node.name))
						return Identifier(node.name);
					return resolveOperand(id, 0);
				}
				break;

			// A muValue always corresponds to a real, mutable loop-carried variable, forced to
			// materialize regardless of blocks -- always safe to trust by name.
			case 'muValue':
				return Identifier(node.name);

			// A thetaValue's exported value IS its mu source's value unchanged -- it exists only to
			// mark where a loop-carried variable becomes readable again after the loop.
			case 'thetaValue':
				return resolveOperand(id, 1);
		}

		// declaredNames confirms `name`'s statement was ACTUALLY printed somewhere reachable -- without
		// a block to schedule it, it may never have been visited at all; falls through to rebuild
		// inline instead of trusting an undeclared identifier.
		const name = slotName(node);
		if (name !== undefined && !isInlinableSlot(node) && declaredNames.has(name))
			return Identifier(name);

		const varName = nodeVariableNames.get(id);
		if (varName)
			return Identifier(varName);

		// Not materialized as a statement anywhere reachable -- most commonly a pure value whose own
		// block was never visited, because a no-real-effect if/else has no structural wrapper to
		// reach it through. Safe to build inline for a pure value; buildExpr has no case for an
		// effect ('effect'-typed nodes go through emitLocalStatements instead), so this can't
		// accidentally duplicate a call's execution.
		return buildExpr(node);
	}

	// A simple local dependency sorter for a single block's nodes
	function localTopologicalSort(ids: NodeId[]): NodeId[] {
		const sorted: NodeId[] = [];
		const visited = new Set<NodeId>();
		const nodeSet = new Set(ids);
		// Tracks nodes OUTSIDE nodeSet already searched through -- never pushed to `sorted`, just
		// walked past, but still need their own cycle guard.
		const walkedThrough = new Set<NodeId>();

		// mu/theta/literal (and a bare 'var' read) resolve directly, never by combining their own
		// inputs -- a mu's port-1 feedback edge in particular points at whatever the loop body
		// computes from the mu itself, so following it here would be both unnecessary and cyclic.
		const hasOrderedInputs = (node: Node) =>
			node.type !== 'mu' && node.type !== 'muValue' && node.type !== 'theta' && node.type !== 'thetaValue' && !isLiteralNode(node)
			&& (node.type !== 'var' || node.declKind !== undefined);

		// Before emitting `node`, everything it depends on must be emitted first -- including
		// TRANSITIVELY, through an input that's itself inlined (not its own nodeSet member): e.g.
		// `let e = i + len;` where `i + len` has no own statement is still a real ordering
		// constraint on `e`, or `i`/`e`'s relative order is undefined.
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
					visitDeps(graph.get(edge.nodeId)!);
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
			visitDeps(graph.get(id)!);
			sorted.push(id);
		};

		for (const id of ids)
			visit(id);

		return sorted;
	}

	function emitLocalStatements(ids: NodeId[]): Statement[] {
		const statements: Statement[] = [];

		for (const id of localTopologicalSort(ids)) {
			const node = graph.get(id)!;

			if (node.type === 'effect') {
				// A user-written break/continue: unlike every other bare 'effect' marker, this DOES
				// need a real printed statement -- real JS routes it to the nearest enclosing loop/switch.
				if (node.name === 'BREAK_MARKER' || node.name === 'CONTINUE_MARKER') {
					statements.push({ type: node.name === 'BREAK_MARKER' ? 'break' : 'continue' } as Statement);
					continue;
				}

				// Same idea, carrying a real value at port 1: the thrown expression.
				if (node.name === 'THROW_MARKER') {
					statements.push({ type: 'throw', argument: resolveOperand(id, 1) } as Statement);
					continue;
				}

				// Same again for `return`: port 1 is left unconnected for a bare `return;` -- this is
				// what makes an early return, nested inside a branch, print correctly in place.
				if (node.name === 'EARLY_RETURN_MARKER') {
					statements.push({ type: 'return', argument: node.inputs[1] ? resolveOperand(id, 1) : undefined } as Statement);
					continue;
				}

				if (isEffect(node)) {
					// A call is safe to inline (skip its own `var tN = f();`) whenever it has EXACTLY ONE
					// real value consumer: an effect is always rootBlocks-anchored to a fixed position,
					// so a pure node consuming it already has its own scheduling window capped there, and
					// buildExpr reconstructs operands in the same order effects were threaded into the
					// state chain -- inlining through an arbitrary pure single-consumer chain preserves
					// order regardless. valueConsumers, not needsTemp: reusing needsTemp's shared counter
					// here changed OTHER callers' behavior too (content vanished from loop bodies).
					if (valueConsumers(node).length === 1)
						continue; // deferred -- the sole consuming call inlines it via resolveNode's fallback
					statements.push(valueConsumers(node).length
						? JS.VarDecl('var', JS.Var(makeTempVar(id), buildEffectExpr(node))) as Statement
						: JS.Expression(buildEffectExpr(node)) as Statement
					);
					continue;
				}
			}

			const name = slotName(node);
			if (name !== undefined) {
				// A plain reassignment or named merge is only worth printing under x's own name if
				// genuinely reused -- a single real consumer can always resolve it lazily instead.
				// forcedPrint overrides this: a reassignment on an exited branch must always print.
				if (isInlinableSlot(node))
					continue;
				// A named except never gets a statement of its own -- each branch already prints its
				// own `x = ...;` directly (forcedPrint); this node exists only so GCM schedules
				// downstream readers of `x` correctly.
				if (node.type === 'except')
					continue;
				const namedStmt = emitNamedSlot(name, node);
				if (namedStmt)
					statements.push(wrapExported(namedStmt, node.exported));
				continue;
			}

			// A pure literal is read directly by resolveNode, never its own statement -- same as the
			// var/mu/... group below (a 'floating' literal has no dedicated tag to list there).
			if (isLiteralNode(node))
				continue;

			switch (node.type) {
				case 'var':
				case 'mu':
				case 'muValue':
				case 'theta':
				case 'thetaValue':
				case 'effect':
					// No statement of their own: vars/mu/muValue/theta/thetaValue are read directly by
					// resolveNode, and non-call effect nodes reaching here are internal bookkeeping
					// markers with no source-level representation (BREAK/CONTINUE/THROW/EARLY_RETURN are
					// already intercepted above).
					break;

				case 'passthru':
					// A genuinely codeless declaration (interface/type-alias/enum/...) -- node.stmt
					// prints verbatim, always regardless of reference count, unlike an ordinary value.
					statements.push(wrapExported(node.stmt, node.exported));
					break;

				case 'class_decl':
					// rebuildClass splices VSDG's own resolution of heritage/keys/method-bodies back
					// into the otherwise-verbatim class before printing.
					statements.push(wrapExported(rebuildClass(node.stmt, node.classInfo!), node.exported));
					break;

				case 'function_decl':
					// Always intercepted earlier, by emitFrom's own per-block dispatch -- reaching here
					// means that dispatch was skipped. No-op rather than mis-printing it.
					break;

				default:
					// forcedPrint: an unnamed node with a real side effect but no value consumer at all
					// -- needsTemp alone would see zero consumers and drop it, correct only for a pure
					// value, never for an effect nothing reads back. Built directly here, not via
					// buildExpr's own 'mutation' case, which assumes it's being read as a merged VALUE
					// (`y = (x = 1)`), returning just the right-hand side -- wrong for a statement.
					if (node.forcedPrint) {
						statements.push(JS.Expression(
							node.type === 'mutation' && node.expr.type === 'binary'
								? { ...(node.expr as Expr & { type: 'binary' }), left: resolveTarget(node.id, 0), right: resolveOperand(node.id, 1) }
								: buildExpr(node)
						) as Statement);
					} else if (needsTemp(node)) {
						statements.push(JS.VarDecl('var', JS.Var(makeTempVar(id), buildExpr(node))));
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
	function needsDirectPlacement(node: Node): boolean {
		if (node.type === 'unary_post' || node.type === 'mutation' || (node.type === 'var' && node.declKind !== undefined))
			return !(node.type === 'mutation' && node.expr.type === 'binary') || !isInlinableSlot(node);
		return false;
	}

	// The inverse of blockIds: which nodes GCM scheduled into a given block, grouped once on first
	// use. A node with no entry in blockIds is left out of every block's list rather than defaulted
	// into 'block_entry' (which used to dump the whole graph there whenever blockIds was incomplete)
	// -- it falls through to resolveNode's own inline fallback wherever it's actually read instead.
	function blockNodes(blockId: BlockId): NodeId[] {
		if (!blockNodesCache) {
			blockNodesCache = new Map();
			for (const id of graph.keys()) {
				const bId = blockIds?.get(id);
				if (bId === undefined)
					continue;
				if (!blockNodesCache.has(bId))
					blockNodesCache.set(bId, []);
				blockNodesCache.get(bId)!.push(id);
			}
		}
		return blockNodesCache.get(blockId) ?? [];
	}
	// Which nodes GCM scheduled alongside a given control-anchor node. Without an assigned block,
	// still returns [anchorId] itself, not [] -- GCM's own convention (an anchor is a member of its
	// own block) is what lets emitControlNode's default case print an ordinary effect/call this way.
	// Also checks for a rebind whose own port-2 state-anchor trigger is this anchor: needsTemp forces
	// such a node to materialize regardless of reuse count, so it needs a real, correctly-positioned
	// statement even when GCM never scheduled it anywhere on its own.
	function nodesAt(anchorId: NodeId): NodeId[] {
		const bId = blockIds?.get(anchorId);
		if (bId !== undefined)
			return blockNodes(bId);
		const ids = [anchorId];
		for (const edges of graph.get(anchorId)!.outputs) {
			if (!edges)
				continue;
			for (const e of edges) {
				if (e.port === 2 && needsDirectPlacement(graph.get(e.nodeId)!))
					ids.push(e.nodeId);
			}
		}
		return ids;
	}

	// Reconstructs the statement span (fromId, boundaryId] in original execution order, by walking
	// inputs[0] backward (exactly one real state predecessor per control-anchor node) and appending
	// this node's own contribution AFTER recursing, so output comes out forward. A backward walk from
	// a known endpoint has no ambiguity, unlike a forward walk (several simultaneous forward
	// consumers of the same state token -- each branch's entry AND the eventual merge -- would tie).
	function emitChain(fromId: NodeId | undefined, boundaryId: NodeId): Statement[] {
		if (fromId === undefined || fromId === boundaryId)
			return [];
		const node = graph.get(fromId)!;
		// A state-theta's own predecessor IS its loop's mu -- theta has no printable statement of its
		// own; the whole loop is reconstructed once, by the mu, when recursion reaches it via this skip.
		if (node.type === 'theta')
			return emitChain(node.inputs[0]?.nodeId, boundaryId);
		return [...emitChain(node.inputs[0]?.nodeId, boundaryId), ...emitControlNode(node)];
	}

	// This control-anchor node's OWN contribution to its enclosing statement list -- the reconstructed
	// if/switch/try/while/function declaration it anchors (plus whatever pure nodes GCM scheduled
	// right alongside it), or (the default case) just those pure nodes, for an anchor with no nested
	// structure of its own (an ordinary call, a declaration, PROGRAM_START, ...).
	function emitControlNode(control: Node): Statement[] {
		const nodes = nodesAt(control.id);

		if (control.type === 'gamma') {
			// Anything else GCM scheduled alongside the merge is split by whether it's a DEPENDENCY
			// (must print before the if) or a DEPENDENT (prints after). The "before" half is emitted
			// first: a value CSE shares between a branch's content and this gamma's own co-scheduled
			// slot must already be registered by the time the branch tries to resolve it.
			const sortedIds		= localTopologicalSort(nodes);
			const gammaIndex	= sortedIds.indexOf(control.id);
			const beforeStmts	= emitLocalStatements(sortedIds.slice(0, gammaIndex));

			// Ports: 0 = predecessor, 1 = condition, 2 = true tail, 3 = false tail.
			const predecessorId	= control.inputs[0].nodeId;
			const trueStmts		= emitChain(control.inputs[2].nodeId, predecessorId);
			// A false tail that never got anywhere past the branch point (no real content) means
			// there's no `else` at all -- as opposed to one that's genuinely empty, which still prints
			// `else {}` (see JS.If's own falseStmts check just below).
			const falseStmts	= control.inputs[3].nodeId !== predecessorId ? emitChain(control.inputs[3].nodeId, predecessorId) : undefined;

			return [
				...beforeStmts,
				JS.If(
					resolveOperand(control.id, 1),
					JS.Block(...trueStmts as JS.Statement<any>[]),
					falseStmts ? JS.Block(...falseStmts as JS.Statement<any>[]) : undefined
				) as Statement,
				...emitLocalStatements(sortedIds.slice(gammaIndex + 1)),
			];
		}

		if (control.type === 'break_scope') {
			// Reconstructed as a real `switch`/`case` -- break_scope has exactly one creation site
			// (BuildVSDG's own 'switch' case), which always stamps switchCases first. The "before"
			// half is emitted first, same reasoning as the gamma case above.
			const sortedIds	= localTopologicalSort(nodes);
			const scopeIndex	= sortedIds.indexOf(control.id);
			const beforeStmts	= emitLocalStatements(sortedIds.slice(0, scopeIndex));

			// The discriminant's (and each case test's) own GCM schedule is driven by its graph
			// consumers, not by this print-time lookup, so it usually lands somewhere this
			// reconstruction never otherwise visits -- needs forcing here, unless some other
			// surviving value already forced it under the same name.
			const forceDeclare = (id: NodeId): Statement[] => {
				const n = graph.get(id)!;
				return n.type === 'var' && n.name !== undefined && !declaredNames.has(n.name)
					? emitLocalStatements([id]) : [];
			};
			const cases = control.switchCases!.map(c => ({
				test:		c.testNodeId ? resolveNode(c.testNodeId) : undefined,
				consequent:	emitChain(c.tailId, c.boundaryId) as JS.Statement<any>[],
			}));

			// Once every case's own value is elided into the post-switch merge, a case's body can end
			// up with nothing left but its own trailing `break;` -- if EVERY case is in that shape,
			// the whole dispatch is observably a no-op and can be dropped entirely, not just each
			// case's reassignment. A continue/return/throw is real content and blocks this.
			const isNoOp = (stmts: JS.Statement<any>[]) => stmts.length === 0 || (stmts.length === 1 && stmts[0].type === 'break');
			const switchIsNoOp = cases.every(c => isNoOp(c.consequent));

			return [
				...beforeStmts,
				...forceDeclare(control.switchDiscriminantId!),
				...control.switchCases!.flatMap(c => c.testNodeId ? forceDeclare(c.testNodeId) : []),
				...(switchIsNoOp ? [] : [JS.Switch(resolveNode(control.switchDiscriminantId!), ...cases) as Statement]),
				...emitLocalStatements(sortedIds.slice(scopeIndex + 1)),
			];
		}

		if (control.type === 'except' && control.name === undefined) {
			// Computed, and the "before" half emitted, BEFORE try/catch/finally's own content -- same
			// reasoning as the gamma case above.
			const sortedIds		= localTopologicalSort(nodes);
			const exceptIndex	= sortedIds.indexOf(control.id);
			const beforeStmts	= emitLocalStatements(sortedIds.slice(0, exceptIndex));

			// Ports: 0 = predecessor, 1 = try's own tail, 2 = catch's own tail, 3 = finally's own tail.
			const predecessorId	= control.inputs[0].nodeId;
			const tryStmts		= emitChain(control.inputs[1].nodeId, predecessorId);
			const catchStmts	= emitChain(control.inputs[2].nodeId, predecessorId);
			// finally's own tail (port 3) is anchored back on `control` itself, not `predecessorId` --
			// its own first statement's predecessor is the except node directly (see BuildVSDG's 'try'
			// case), not the state from before the whole try/catch.
			const finallyEdge	= control.inputs[3];
			const finallyStmts	= finallyEdge ? emitChain(finallyEdge.nodeId, control.id) : undefined;

			return [
				...beforeStmts,
				{
					type:			'try',
					block:			tryStmts as JS.Statement<any>[],
					handlerParam:	control.catchParam,
					handlerBody:	catchStmts as JS.Statement<any>[],
					finalizer:		finallyStmts as JS.Statement<any>[] | undefined,
				} as Statement,
				...emitLocalStatements(sortedIds.slice(exceptIndex + 1)),
			];
		}

		if (control.type === 'function_decl') {
			// Before, then body -- same reasoning as the gamma case above.
			const sortedIds			= localTopologicalSort(nodes);
			const declIndex			= sortedIds.indexOf(control.id);
			const beforeStmts			= emitLocalStatements(sortedIds.slice(0, declIndex));
			const bodyStatements	= reconstructFunctionBody(control);
			return [
				...beforeStmts,
				wrapExported({ ...rebuildParams(control.stmt as JS.FunctionDecl<any>, control), body: bodyStatements } as Statement, control.exported),
				...emitLocalStatements(sortedIds.slice(declIndex + 1)),
			];
		}

		if (control.type === 'mu') {
			const thetaEdge	= (control.outputs[0] ?? []).find(e => graph.get(e.nodeId)!.type === 'theta');
			const thetaNode	= thetaEdge && graph.get(thetaEdge.nodeId)!;

			// The mu's own block holds the mu node plus any loop-body computation whose only real
			// dependency IS the mu (no other anchor to place it at). Anything with a real effect
			// continues from the body's own entry, via port 1 (the feedback input).
			const ownIds		= nodes.filter(id => id !== control.id);

			const statements: Statement[] = [];

			if (thetaNode) {
				const testId	= thetaNode.inputs[1].nodeId;
				const testNode	= graph.get(testId)!;
				// The test's only REAL reader (besides itself) is normally the state-theta's own
				// condition port -- everything else pointing at it is vestigial.
				const onlyReadByLoopExit = (testNode.outputs[0] ?? []).filter(e => !isVestigialEdge(graph.get(e.nodeId)!, e.port))
					.every(e => e.nodeId === thetaNode.id);
				// Emitted before restOfBody, same CSE-registration reasoning as the gamma case above.
				const testStatements	= onlyReadByLoopExit ? [] : emitLocalStatements([testId]);
				const restStatements	= emitLocalStatements(ownIds.filter(id => id !== testId));
				const restOfBody		= emitChain(control.inputs[1].nodeId, control.id);

				if (control.loopKind === 'do') {
					// No rotation needed: the body already runs before the test in do-while's own
					// native semantics (the mu's INITIAL value is what the body sees on its first pass).
					statements.push(JS.DoWhile(JS.Block(
						...restOfBody as JS.Statement<any>[],
						...restStatements as JS.Statement<any>[],
						...testStatements as JS.Statement<any>[]
					), resolveOperand(thetaNode.id, 1)) as Statement);
				} else {
					// LOOP ROTATION: the condition needs values that only exist once already inside the
					// loop body, so `while (cond) {...}` is structurally impossible -- `while (true) {
					// <compute cond>; if (!cond) break; body }` isn't. A condition resolving to the
					// literal `true` (a real `for(;;)`, or a for-of/for-in desugar) makes the check
					// provably dead, so it's dropped instead of printed as inert clutter.
					const condExpr = resolveOperand(thetaNode.id, 1);
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
				const restStatements = emitLocalStatements(ownIds);
				const restOfBody = emitChain(control.inputs[1].nodeId, control.id);
				statements.push(JS.While(Literal(true),
					JS.Block(...restStatements as JS.Statement<any>[], ...restOfBody as JS.Statement<any>[])
				) as Statement);
			}

			if (thetaNode) {
				// Anything scheduled into the state-theta's own block needs emitting explicitly here,
				// right after the loop -- a pure computation depending only on a named theta's exported
				// value has nothing to state-chain through, so the recursive walk would never find it.
				statements.push(...emitLocalStatements(nodesAt(thetaNode.id).filter(id => id !== thetaNode!.id)));
			}

			return statements;
		}

		return emitLocalStatements(nodes);
	}

	// Reconstructs a 'function_decl'-anchored subgraph's own body -- its own fully independent
	// region (own entry/RETURN_ANCHOR pair, own scope). returnNodeId is the only way to find the
	// RETURN_ANCHOR from here -- no ordinary graph edge from entry to return survives an empty body.
	function reconstructFunctionBody(entryNode: Node): Statement[] {
		const returnNode		= graph.get(entryNode.returnNodeId!)!;
		// A fresh declaredNames frame per function body -- this function's own locals must never
		// collide with an unrelated sibling/enclosing function's locals sharing the same name.
		declaredNames.push();
		const bodyStatements	= emitChain(returnNode.inputs[0].nodeId, entryNode.id);

		// Unconnected means the body fell off its natural end with no explicit return -- see
		// buildFunctionBody's own comment on why omitting the trailing statement is always correct.
		if (returnNode.inputs[1])
			bodyStatements.push({ type: 'return', argument: resolveOperand(returnNode.id, 1) } as Statement);
		declaredNames.pop();
		return bodyStatements;
	}

	// A single-expression counterpart to reconstructFunctionBody, for an INSTANCE field's own
	// initializer (an expression body, not a statement list, so no EARLY_RETURN_MARKER involved).
	function resolveFieldInitializer(entryNode: Node): Expr {
		return resolveOperand(entryNode.returnNodeId!, 1);
	}

}

// A constant: a 'floating' node whose own expr is a literal (an original literal, or one
// foldConstants folded a binary/unary into in place -- same shape, no distinct tag).
function isLiteralNode(node: Node): node is Node & { expr: Expr & { type: 'literal' } } {
	return node.type === 'floating' && node.expr?.type === 'literal';
}

function foldConstants(graph: VSDG, node: Node): boolean {
	// 'mutation' is deliberately excluded (not just practically inert, since calcUnary has no
	// '++'/'--' case and a real assignment's left operand is never itself a literal) -- folding a
	// mutation into a bare literal would silently discard the effect it exists to perform.
	if (node.type !== 'floating')
		return false;
	const expr = node.expr;
	switch (expr.type) {
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
			if (isLiteralNode(left) && isLiteralNode(right)) {
				const r = calcBinary(expr.operator, left.expr.value, right.expr.value);
				if (r !== undefined) {
					// Fold in place into a literal (a 'floating' node with a literal expr), then
					// drop the now-meaningless incoming edges.
					node.expr = Literal(r);
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
			if (isLiteralNode(operand)) {
				const r = calcUnary(expr.operator, operand.expr.value);
				if (r !== undefined) {
					node.expr = Literal(r);
					graph.removeInputs(node);
					return true; // Graph was modified!
				}
			}
			return false;
		}
	}
	return false;
}


// Every NodeId referenced OUTSIDE the ordinary inputs/outputs edge graph (switchCases, returnNodeId,
// classInfo, ...). None of foldConstants/foldDeadBranches/optimizeStructuralCSE know about these
// side channels -- they only rewire inputs/outputs -- so a node reachable ONLY this way must never
// be removed/merged away, or the reference is left pointing at a deleted id.
function collectProtectedNodeIds(graph: VSDG): Set<NodeId> {
	const ids = new Set<NodeId>();
	for (const node of graph.values()) {
		if (node.returnNodeId !== undefined)
			ids.add(node.returnNodeId);
		if (node.programEndId !== undefined)
			ids.add(node.programEndId);
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
		// An object literal's own method/get/set properties -- same out-of-band reference shape as
		// classInfo's own members, same reason it needs protecting (BuildVSDG's 'object' case).
		for (const m of node.objectMembers ?? []) {
			if (m?.keyNodeId !== undefined)
				ids.add(m.keyNodeId);
			if (m?.entryNodeId !== undefined)
				ids.add(m.entryNodeId);
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

		// 3. Merge structurally-identical pure computations -- runs once per round (a whole-graph
		// pass, unlike the two per-node checks above): constant folding can turn two expressions
		// identical, and CSE merging can turn a condition constant, so neither converges alone.
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
	if (isLiteralNode(condNode)) {
		// Find the edge representing the winning path (true path, then false path)
		const winningEdge = graph.getEdge0(node, condNode.expr.value ? port + 1 : port + 2);
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

		// Delete the Gamma node and its incoming edges from the graph
		graph.removeNode(node);
		return true; // Graph was modified!
	}

	return false;
}

function getStructuralKey(node: Node): string {
	let key = node.type;
	// Checked as three separate fields now (expr/name/stmt), not one untyped `value` -- 'member'
	// (its own `.name` + `.optional`) never actually reaches here, since optimizeStructuralCSE's
	// own caller excludes it before ever calling this.
	if (node.expr !== undefined) {
		// A 'floating' node's own real discriminator lives in node.expr's own .type, not node.type
		// (a 'mutation' node never reaches here -- excluded before this, its only caller, runs).
		switch (node.type === 'floating' ? node.expr.type : node.type) {
			case 'binary':
			case 'unary': key += (node.expr as Expr & { type: 'binary' | 'unary' }).operator;
				break;
			// JSON.stringify, not a bare `+=`: this also naturally distinguishes a literal's own
			// falsy value (0/false/''/null) from a genuinely valueless node, since `node.expr` is
			// the wrapper OBJECT, always defined once assigned regardless of what it wraps. The
			// replacer handles a bigint anywhere inside it -- JSON.stringify otherwise throws
			// outright on a raw bigint.
			default: key += JSON.stringify(node.expr, (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v);
		}
	} else if (node.name !== undefined) {
		key += node.name;
	} else if (node.stmt !== undefined) {
		key += JSON.stringify(node.stmt, (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v);
	}

	return key + ':' + node.inputs.map(e => e ? `${e.nodeId}:${e.port}` : '').join(',');
}

export function optimizeStructuralCSE(graph: VSDG, protectedIds: Set<NodeId>): boolean {
	let anyChanges = false;

	// Maps a structural string signature back to the first Node that computed it
	const structuralTable = new Map<string, Node>();

	for (const node of graph.values()) {
		// Skip nodes with side-effects or control-flow tokens -- sequence-dependent, can't collapse
		// on data inputs alone. 'this'/'super' are also unsafe: identical structural key regardless
		// of which method they're in, but each one's real value is bound per call. 'array'/'object'
		// get a fresh identity per evaluation in real JS, unlike a true literal. 'member'/'index'
		// reads can observe an intervening mutation between two textually-identical occurrences.
		// 'mutation' is unsafe for the most direct reason: each occurrence is a distinct real effect.
		if (['mu', 'muValue', 'theta', 'thetaValue', 'gamma', 'gammaValue', 'effect', 'member', 'mutation'].includes(node.type))
			continue;
		// 'array'/'object'/'index'/'this'/'super' share the uniform 'floating' tag, so the check
		// moves to node.expr's own .type -- same exclusion, same reasoning as above ('this'/'super':
		// identical structural key regardless of which method they're in, but each one's real value
		// is bound per call, so merging them conflates two different receivers).
		if (node.type === 'floating' && (['array', 'object', 'index', 'this', 'super'] as (Expr['type'])[]).includes(node.expr.type))
			continue;

		// Generate the unique structural signature for this node
		const key = getStructuralKey(node);

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

// Discovers the program's branch/loop structure -- purely from control anchors and each one's own
// state predecessor, with no involvement from ordinary value nodes. It doesn't decide where
// anything reused/floating gets placed (applyGlobalCodeMotion's own job, layered on top), just
// answers "where are the branches and loops, and how do they nest."
function buildBlockTree(graph: Map<NodeId, Node>) {
	// 1. Discover control anchors and build 'rootBlocks'.
	// PROGRAM_START gets the well-known id 'block_entry' -- BuildProgram needs a fixed, known
	// starting point to begin its traversal from.
	const rootBlocks = new Map<NodeId, BlockId>();
	let blockCounter = 0;
	for (const [id, node] of graph.entries()) {
		if (node.type === 'effect' && node.name === 'PROGRAM_START') {
			rootBlocks.set(id, 'block_entry');
		} else if (node.type === 'effect') {
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		} else if (node.type === 'gamma' || node.type === 'mu' || node.type === 'theta' || node.type === 'break_scope') {
			// gamma/mu/theta each have their own dedicated type tag, distinct from the per-variable
			// gammaValue/muValue/thetaValue, so no typeof-value check is needed to tell them apart
			// (unlike except below) -- a unified tag relying on that would mis-schedule a thetaValue,
			// whose own port 0 is a CONDITION operand, not a state predecessor.
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		} else if (node.type === 'except' && node.name === undefined) {
			// except still shares one type tag between its state and NAMED forms, so this check
			// matters here.
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		} else if (node.type === 'function_decl' || node.type === 'passthru' || node.type === 'class_decl') {
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
		}
	}

	// The reverse of rootBlocks -- built once here so getLoopDepth can look up a block's real node
	// type directly, instead of guessing from the block id's string prefix.
	const blockControl = new Map<BlockId, NodeId>();
	for (const [nodeId, blockId] of rootBlocks)
		blockControl.set(blockId, nodeId);

	// Maps a Block ID to its immediate parent Block ID in the Dominator Tree
	const blockTree = new Map<BlockId, BlockId>();

	// The entry block has no parent -- deliberately left unset, not a self-loop, so every
	// walk-to-root loop below terminates at 'block_entry' instead of spinning forever.

	for (const [nodeId, blockId] of rootBlocks.entries()) {
		if (!blockId)
			continue;

		// Port 0 is the real state predecessor for every control-anchor type by construction.
		const incomingStateEdge = graph.get(nodeId)?.inputs[0];
		if (incomingStateEdge)
			// Find which block contains the node that produced our incoming state token
			blockTree.set(blockId, rootBlocks.get(incomingStateEdge.nodeId) ?? '');
	}

	// How many loops enclose a block: a state-mu's own block is one deeper than its blockTree
	// parent; a state-theta's block is the EXIT of its own mu -- despite being a blockTree
	// descendant of it, it runs once after the loop, so its depth is the loop's OWN parent's,
	// not one more; every other block just inherits its parent's depth unchanged.
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
	// 'block_entry' or a function's own FUNCTION_BODY_START marker. Deliberately NOT the
	// function_decl node's own block: that's reachable from BOTH the function's body and whatever
	// textually follows the declaration, so blockTree ancestry alone can't tell them apart -- the
	// dedicated start marker is what disambiguates, since only the body threads from it.
	const regionRootMemo = new Map<BlockId, BlockId>();
	function regionRootOf(blockId: BlockId): BlockId {
		const cached = regionRootMemo.get(blockId);
		if (cached !== undefined)
			return cached;
		const control = blockId !== 'block_entry' ? graph.get(blockControl.get(blockId)!) : undefined;
		let root = blockId;
		if (blockId !== 'block_entry' && !(control?.type === 'effect' && control.name === 'FUNCTION_BODY_START')) {
			const parent = blockTree.get(blockId);
			root = parent !== undefined ? regionRootOf(parent) : blockId;
		}
		regionRootMemo.set(blockId, root);
		return root;
	}

	// A function_decl's own block is deliberately ambiguous for regionRootOf -- but a PARAM reading
	// that node directly (ports >= 1, port 0 reserved for the state chain) is never one of the two
	// ambiguous cases: it's unconditionally inside the function. scheduleEarly uses this instead of
	// the function_decl's own block for such edges, or a value derived only from params gets pinned
	// at a block regionRootOf resolves to block_entry, stranding it outside the function.
	const functionBodyBlockMemo = new Map<NodeId, BlockId>();
	function functionBodyBlockOf(functionDeclId: NodeId): BlockId {
		const cached = functionBodyBlockMemo.get(functionDeclId);
		if (cached !== undefined)
			return cached;
		const bodyStart = (graph.get(functionDeclId)!.outputs[0] ?? [])
			.map(e => graph.get(e.nodeId)!)
			.find(n => n.type === 'effect' && n.name === 'FUNCTION_BODY_START');
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

		// Default to the program's first entry block -- unless this is a 'this'/'super' node (or
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
			// among all inputs. A param edge uses the function's own body block instead of the
			// function_decl's own. Checked via `returnNodeId`, not `.type === 'function_decl'`: an
			// arrow/function EXPRESSION's entry node has its `.type` overwritten to 'effect', so the
			// type check alone would silently miss a param read inside one.
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

				// A mu's port 1 is its FEEDBACK edge, a genuine back-edge -- it doesn't constrain
				// "must be ready by" the mu's own block, or latestBlock could come out shallower
				// than earliestBlock, a contradiction the walk below can't reconcile.
				if ((consumerNode.type === 'mu' || consumerNode.type === 'muValue') && consumerEdge.port === 1)
					continue;

				// Same structural issue for if/else: feeding a gammaValue's trueVal/falseVal only
				// means "I'm one of the two alternatives", not "ready by the gammaValue's own block"
				// -- that block sits AFTER both branches, not inside either one.
				if (consumerNode.type === 'gammaValue' && consumerEdge.port !== 0)
					continue;

				// Same issue for a NAMED except's tryVal/catchVal -- unlike a named gamma, both ports
				// here are value ports (no condition port), so both are excluded.
				if (consumerNode.type === 'except' && consumerNode.name !== undefined)
					continue;

				// Same issue for the state theta's own port-1 (condition): the theta's block is
				// "after the loop exited", logically outside it, but the condition it reads is
				// computed INSIDE the loop every iteration -- treating this as an ordinary constraint
				// would schedule it one loop-nesting level shallower than everything else it feeds.
				if (consumerNode.type === 'theta' && consumerEdge.port === 1)
					continue;

				// Likewise never actually read by codegen -- left as an ordinary constraint, this
				// dragged the OLD value's own declaration/scheduling into wherever the assignment
				// itself happened to live (e.g. into an if-branch it has no real reason to be inside).
				if (isVestigialEdge(consumerNode, consumerEdge.port))
					continue;

				let consumerBlock = blockIds.get(consumerEdge.nodeId)!;

				// A mu's port 0 (its INITIAL, pre-loop value) belongs to the block BEFORE the loop --
				// the pre-header, the immediate dominator sitting right outside the loop structure.
				if ((consumerNode.type === 'mu' || consumerNode.type === 'muValue') && consumerEdge.port === 0)
					consumerBlock = blockTree.get(consumerBlock) || "block_entry";

				// A consumer in a DIFFERENT function's own region (e.g. a captured variable's
				// reassignment, read by name after the function returns) might run zero, one, or many
				// times, at a point this static schedule can't place -- treating it as an ordinary
				// constraint would (and did) drag the node out of the function it belongs in.
				// forcedPrint keeps such a node from being dropped once its only consumer is excluded.
				if (regionRootOf(consumerBlock) !== regionRootOf(blockIds.get(nodeId)!))
					continue;

				latestBlock = latestBlock === null
					? consumerBlock
					: findLeastCommonAncestor(blockTree, latestBlock, consumerBlock);
			}
		}

		// Click's Core Sinking Choice: walk from the latest possible block up to the earliest,
		// picking the SHALLOWEST valid block along the way (lowest execution frequency) -- never
		// shallower than earliestBlock's own depth, which already encodes the deepest position this
		// node's inputs actually require.
		//
		// Ties matter: getLoopDepth only counts LOOP nesting, so blocks within one loop iteration
		// (or one un-looped chain) can tie despite being meaningfully different positions. On a tie,
		// prefer whichever is closer to latestBlock, not earliestBlock -- otherwise a node whose sole
		// consumer lives right next to it gets hoisted back to its earliest position, landing in a
		// different block than the consumer that needs it.
		//
		// KNOWN GAP, deliberately not fixed here (tried and reverted): two adjacent, same-depth
		// declarations that are each other's own anchor (`let i = off, e = i + len;`) can have this
		// tie-break pick the wrong one, swapping their printed order. A version preferring a node's
		// own port-2 anchor on a tie fixed that but broke dead-bookkeeping elision elsewhere (a
		// switch's own unused `__hit`/`__match` scaffolding) -- the two cases are indistinguishable
		// from information available at this point in scheduling.
		const earliestBlock	= blockIds.get(nodeId)!;
		const floor			= getLoopDepth(earliestBlock);
		let bestBlock: BlockId | undefined;
		let bestDepth		= Infinity;

		// The `currentBlock` guard is a defensive backstop against a blockTree dead end that
		// doesn't pass through earliestBlock on the way to the root.
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

// Wraps a reconstructed statement in `export `/`export default `, per a node's own `exported` stamp.
function wrapExported(stmt: Statement, exported: 'named' | 'default' | undefined): Statement {
	return exported === 'named' ? { type: 'export_decl', declaration: stmt } as Statement
		: exported === 'default' ? { type: 'export', default: stmt } as Statement
		: stmt;
}

