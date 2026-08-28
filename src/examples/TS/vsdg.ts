import * as JS from './js-parser';
import * as TS from './ts-parser';
import { Identifier, Literal } from '../common';
import { Walkable, walkB, calcUnary, calcBinary } from './walker';

const ASSIGN_OPS	= new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);
type Expr			= TS.Expr;
type Statement		= TS.Statement;

// VSDG
type NodeInner =
	| {type: 'literal',		value: number|bigint}
	| {type: 'var',			value?: string}
	| {type: Expr['type'],	value: Expr}
	| {type: 'effect',		value: Expr}
	| {type: 'mu',			value?: string}
	| {type: 'theta',		value?: string}
	| {type: 'gamma',		value?: string}

type NodeId = string;

interface Edge {
	nodeId:	NodeId;
	port:	number; 
}

class Node {
	inputs:		Edge[]		= [];	// inputs[port] = The single specific source edge feeding this slot
	outputs:	Edge[][]	= [];	// outputs[port] = An array of ALL downstream edges consuming this specific channel
	constructor(public id: string, public type: string, public value?: any) {}
	inDegree()	{ return this.inputs.length; }
	outDegree() { return this.outputs.reduce((sum, arr) => sum + arr.length, 0); }
	isUnused(port: number) { return this.outputs[port]?.length === 0; }
}

function connectValue(
	from:	Node, outputPort: number, 
	to:		Node, inputPort: number
): void {
	to.inputs[inputPort] = { nodeId: from.id, port: outputPort };
	(from.outputs[outputPort] ??= []).push({ nodeId: to.id, port: inputPort });
}

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

	constructor(parent: Scope, public makeNode: (type: string, varName: string) => Node) {
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
			connectValue(old, 0, mu, 0);	// Slot 0 = Initial value from outside
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
	let end: Node;
	let nextId = 0;

	function makeNode(type: string, value?: any) {
		const id	= type + String(nextId++);
		const node	= new Node(id, type, value);
		graph.set(id, node);
		return node;
	}
	function makeExprNode(expr: Expr, type: string = expr.type) {
		const node = makeNode(type, expr);
		expnodes.set(expr, node);
		return node;
	}
	function getExprNode(expr: Expr) {
		const node = expr.type === 'identifier' ? scope.get(expr.name) : expnodes.get(expr);
		if (!node)
			throw "missing node";
		return node;
	}
	function getState() {
		return { scope, end };
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

					// 3. Seed an isolated local scope for the function body
					// This isolates function variables completely from the outer global scope
					const fnScope = new Scope(scope);

					// Wire incoming output ports from the entry node directly to parameter bindings
					s.params.forEach(p => {
						// Port 0 is reserved for State. Parameters start strictly at Port 1.
						if (typeof p.key === 'string')
							fnScope.create(p.key, entryNode);
						// Note: For a strict multi-port lookup, reads to this param node 
						// will query outputPort = index + 1
					});

					// 4. Temporarily swap the master compiler pointers into the function's region

					scope = fnScope;
					end = entryNode; // The sequential state chain inside the function hangs off the entry node

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
					return false;
				}
				case 'return': {
					// 1. If the return statement carries a value, evaluate it
					if (s.argument) {
						recurse(s.argument);
						// Write the returned node to our reserved identifier channel
						scope.set('_return_val', getExprNode(s.argument));
					}

					// 2. Terminate the state sequence for this path
					// In a production VSDG compiler, an early return branches execution state.
					// We update 'end' to signal that this path has completed its state sequence.
					const returnStateMarker = makeNode('effect', 'EARLY_RETURN_MARKER');
					connectValue(end, 0, returnStateMarker, 0);
					end = returnStateMarker;
					return false;
				}
				case 'var_decl': {
					process(s);
					for (const v of s.declarations) {
						if (typeof v.name === 'string')
							scope.create(v.name, v.init ? getExprNode(v.init) : makeNode('var', v.name));
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
					recurse(s.test);
					const test		= getExprNode(s.test);
					const parent	= getState();

					// 3. Walk the True branch
					scope = new Scope(parent.scope);
					process(s.consequent);
					const trueState		= getState();

					// 4. Walk the False branch
					scope = new Scope(parent.scope);
					if (s.alternate)
						process(s.alternate);
					const falseState	= getState();

					// 5. Reconcile the STATE - if either branch modified state, we must merge the state paths using a Gamma node
					if (trueState.end !== parent.end || falseState.end !== parent.end) {
						end = makeNode('gamma');
						connectValue(test, 0, end, 0);				// Slot 0 = Condition
						connectValue(trueState.end, 0, end, 1);		// Slot 1 = True State
						connectValue(falseState.end, 0, end, 2);	// Slot 2 = False State
					}

					// 6. Identify the mutations by gathering local keys from both delta scopes
					scope = parent.scope;
					const divergedVariables = new Set([
						...trueState.scope.bindings.keys(),
						...falseState.scope.bindings.keys()
					]);

					// 7. Reconcile only what actually changed
					for (const name of divergedVariables) {
						const trueVal	= trueState.scope.get(name)!;
						const falseVal	= falseState.scope.get(name)!;

						// If the values ended up different, create the Gamma stitch
						if (trueVal !== falseVal) {
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
					const muScope	= new ScopeMu(scope, makeNode);

					connectValue(end, 0, muEnd, 0); // Slot 0 = Initial value from outside

					scope	= muScope;
					end		= muEnd;

					// 3. Walk the loop condition expression
					// It evaluates using the values provided by our new Mu entry nodes.
					recurse(s.test);
					const test = getExprNode(s.test);

					// 4. Walk the loop body statements
					process(s.body);

					// 5. Connect the loop body feedback loops back into the MU nodes (Slot 1)
					// Connect the final side-effect state of the loop body back to the State Mu
					connectValue(end, 0, muEnd, 1);				// Slot 1 = Feedback loop

					// Connect updated variable values back to their respective Value Mus
					scope = preLoop.scope;
					for (const [name, node] of muScope.bindings) {
						const muNode = muScope.muNodes.get(name)!;
						connectValue(muNode, 0, node, 1);	// Slot 1 = Feedback loop

						const theta = makeNode('theta', name);
						connectValue(test, 0, theta, 0);	// Slot 0 = Condition
						connectValue(muNode, 0, theta, 1);	// Slot 1 = Value to pass out
						// Update global environment so downstream code reads the post-loop value
						scope.set(name, theta);
					}

					// 6. Create THETA (Exit) nodes to export the final values outside the loop
					// The Theta node prevents values from escaping until the condition is false.
					end = makeNode('theta');
					connectValue(test, 0, end, 0); 		// Slot 0 = Loop termination condition
					connectValue(muEnd, 0, end, 1);		// Slot 1 = Value to pass out
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
			switch (s.type) {
				case 'literal':
					expnodes.set(s, makeNode('literal', s.value));
					break;

				case 'identifier':
					break;

				case 'unary': {
					process(s);
					const node = makeExprNode(s as Expr);
					connectValue(getExprNode(s.operand), 0, node, 0);
					if (s.operator === '++' || s.operator === '--') {
						if (s.operand.type === 'identifier')
							scope.set(s.operand.name, node);
					}
					break;
				}
				case 'binary': {
					process(s);
					const node = makeExprNode(s as Expr);
					connectValue(getExprNode(s.left), 0, node, 0);
					connectValue(getExprNode(s.right), 0, node, 1);
					if (ASSIGN_OPS.has(s.operator)) {
						if (s.left.type === 'identifier')
							scope.set(s.left.name, node);
					}
					break;
				}

				case 'call': {
					// 1. Thread the State Edge to preserve sequence
					process(s);
					const node = makeExprNode(s, 'effect');
					connectValue(end, 0, node, 0); // Slot 0 = Input State
					// Update the current state pointer to this new call
					end = node;

					// 2. Thread Value Edges for the function arguments
					s.arguments.forEach((arg, index) => connectValue(getExprNode(arg), 0, node, index + 1));
					break;
				}

				case 'function': {
					const outer = getState();

					// 1. Establish the internal localized graph builder context

					// 2. Instantiate the Function Boundary Nodes
					const entryNode		= makeExprNode(s);
					const returnNode	= makeNode('effect', 'RETURN_ANCHOR');

					// 3. Seed an isolated local scope for the function body
					// This isolates function variables completely from the outer global scope
					const fnScope = new Scope(scope);

					// Wire incoming output ports from the entry node directly to parameter bindings
					s.params.forEach(p => {
						// Port 0 is reserved for State. Parameters start strictly at Port 1.
						if (typeof p.key === 'string')
							fnScope.create(p.key, entryNode);
						// Note: For a strict multi-port lookup, reads to this param node 
						// will query outputPort = index + 1
					});

					// 4. Temporarily swap the master compiler pointers into the function's region

					scope = fnScope;
					end = entryNode; // The sequential state chain inside the function hangs off the entry node

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
					return false;
				}

				case 'member': {
					process(s);
					const node = makeNode('member', s.property);
					expnodes.set(s, node);
					connectValue(getExprNode(s.object), 0, node, 0);
					break;
				}
				case 'index': {
					process(s);
					const node = makeExprNode(s);
					connectValue(getExprNode(s.object), 0, node, 0);
					connectValue(getExprNode(s.property), 0, node, 1);
					break;
				}

				default:
					console.log(`not handling expr ${s.type}`);
					break;

			}
			return process(s);
		}
	);
	return graph;
}

export class Output {
	nodeVariableNames = new Map<NodeId, string>();
	tempVarCounter = 0;

	constructor(public graph: Map<NodeId, Node>) {}

	makeVar(id: NodeId) {
		const varName 	= `t${this.tempVarCounter++}`;
		this.nodeVariableNames.set(id, varName);
		return varName;
	}

	resolveOperand(to: NodeId, slot: number) {
		// 1. Find the edge connecting to this specific slot
		const edge = this.graph.get(to)!.inputs[slot];
		if (!edge)
			throw new Error(`Missing operand edge for slot ${slot} on node ${to}`);

		const sourceId		= edge.nodeId;
		const sourceNode	= this.graph.get(sourceId)!;

		// 2. If the source is a pure constant, we can inline its value directly into the statement
		if (sourceNode.type === 'literal')
			return Literal(sourceNode.value);

		if (sourceNode.type === 'var')
			return sourceNode.value;

		// 3. Otherwise, look up the name of the temporary variable we assigned to that calculation
		const varName = this.nodeVariableNames.get(sourceId);
		if (!varName)
			throw new Error(`Node ${sourceId} was consumed before it was assigned a variable name!`);

		return Identifier(varName);
	}

	// A simple local dependency sorter for a single block's nodes
	localTopologicalSort(ids: NodeId[]): NodeId[] {
		const sorted: NodeId[] = [];
		const visited = new Set<NodeId>();
		const nodeSet = new Set(ids);

		const visit = (id: NodeId) => {
			if (visited.has(id))
				return;

			const node = this.graph.get(id)!;

			// Before emitting this node, all its inputs that belong to the SAME block must be emitted first
			for (const edge of node.inputs) {
				if (edge && nodeSet.has(edge.nodeId))
					visit(edge.nodeId);
			}

			visited.add(id);
			sorted.push(id);
		};

		for (const id of ids)
			visit(id);

		return sorted;
	}

	emitLocalStatements(ids: NodeId[]): Statement[] {
		const localStatements: any[] = [];
		ids = this.localTopologicalSort(ids);

		for (const id of ids) {
			const node = this.graph.get(id)!;
			switch (node.type) {

				case 'literal':
					// Pure constants don't need a standalone line of code;
					// they will be inline-read by their consumer expressions.
					break;

				case 'unary': {
					const un = node.value as (Expr & {type: 'unary'});
					localStatements.push(JS.VarDecl('const', JS.Var(this.makeVar(id), {...un,
						operand: this.resolveOperand(id, 0),
					})));
					break;
				}
				case 'binary': {
					const bin = node.value as (Expr & {type: 'binary'});
					localStatements.push(JS.VarDecl('const', JS.Var(this.makeVar(id), {...bin,
						left: this.resolveOperand(id, 0),
						right: this.resolveOperand(id, 1)
					})));
					break;
				}

				case 'call': {
					const call = node.value as (Expr & {type: 'call'});
					localStatements.push(JS.Expression({...call,
						arguments: call.arguments.map((a, i) => this.resolveOperand(id, i))
					} as Expr));
					break;
				}

				default:
					console.log(`not handling node ${node.type}`);
					break;
			}
		}

		return localStatements;
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

	// Find the edge supplying the condition (Slot 0)
	const condEdge = graph.getEdge0(node, 0);
	if (!condEdge)
		return false;

	const condNode = graph.getNode(condEdge.nodeId);

	// If the condition is a known constant boolean (or truthy/falsy value)
	if (condNode.type === 'literal') {
		// Slot 1 is the True path, Slot 2 is the False path

		// Find the edge representing the winning path
		const winningEdge = graph.getEdge0(node, condNode.value ? 1 : 2);
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

type BlockId = string;

// A basic block grouping for scheduling
interface BasicBlock {
//	parent?:	BlockId;
	control:	NodeId; 	// The mu, gamma, or effect node that anchors this block
	nodes:		NodeId[];	// unordered list of nodes executing inside this block
}

function findLeastCommonAncestor<N>(blockTree: Map<N, N>, blockA: N, blockB: N): N|null {
	const pathA = new Set<N>();

	// Trace path from Block A all the way up to the entry root
	for (let current = blockA; current; current = blockTree.get(current)!)
		pathA.add(current);

	// Trace path from Block B up until it hits any block visited by Path A
	for (let current = blockB; current; current = blockTree.get(current)!) {
		if (pathA.has(current))
			return current; // Found the intersection point!
	}
	return null;
}

function getLoopDepth(blockId?: BlockId): number {
	if (!blockId)
		return 0;

	// In a production layout, loop depth is pre-computed during block generation.
	// For your string-based naming conventions, we count the 'mu' loops:
	return blockId.startsWith('mu')
		? 1 // Basic single loop depth
		: 0;
}

function isDeeperThan<N>(blockTree: Map<N, N>, blockA: N, blockB: N): boolean {
	// Strategy: Count steps to the root. The block with more ancestors is deeper.
	let depthA = 0;
	for (let current: N|undefined = blockA; current; current = blockTree.get(current))
		depthA++;

	let depthB = 0;
	for (let current: N|undefined = blockB; current; current = blockTree.get(current))
		depthB++;

	return depthA > depthB;
}

function getLoopPreHeader(loopBlockId: BlockId, blockTree: Map<BlockId, BlockId>): BlockId {
	// The pre-header is the immediate dominator sitting right outside the loop structure.
	return blockTree.get(loopBlockId) || "block_entry";
}

export function applyGlobalCodeMotion(graph: Map<NodeId, Node>) {
	const blockIds		= new Map<NodeId, BlockId>();

	// 1. Discover control anchors (mu, gamma, effect) and build 'rootBlocks'
	const rootBlocks = new Map<NodeId, BlockId>();
	//rootBlocks.set("0", "block_entry"); // Assuming node "0" is your STATE_START
	let blockCounter = 0;
	for (const [id, node] of graph.entries()) {
		// mu, gamma, and effect calls have hard sequential side-effects
		if (['mu', 'gamma', 'effect', 'theta'].includes(node.type))
			rootBlocks.set(id, `${node.type}_${blockCounter++}`);
	}

	// Maps a Block ID to its immediate parent Block ID in the Dominator Tree
	const blockTree = new Map<BlockId, BlockId>();

	// The entry block has no parent
	blockTree.set("block_entry", "block_entry");

	for (const [nodeId, blockId] of rootBlocks.entries()) {
		if (!blockId)
			continue;

		// input slot 0 of a state node is the incoming state edge
		const incomingStateEdge = graph.get(nodeId)?.inputs[0];
		if (incomingStateEdge)
			// Find which block contains the node that produced our incoming state token
			blockTree.set(blockId, rootBlocks.get(incomingStateEdge.nodeId) ?? '');
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
		for (const edge of node.inputs) {
			if (edge) {
				scheduleEarly(edge.nodeId);
				// The current node must be scheduled AFTER its inputs are ready.
				// We find the deepest block among all inputs.
				if (blockIds.has(edge.nodeId) && isDeeperThan(blockTree, blockIds.get(edge.nodeId), earliestBlock))
					earliestBlock = blockIds.get(edge.nodeId)!;
			}
		}

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
				let consumerBlock = blockIds.get(consumerEdge.nodeId)!;

				// Special case: If the consumer is a loop-entry 'mu' node, 
				// its input belongs to the block *before* the loop.
				if (consumerNode.type === 'mu' && consumerEdge.port === 1)
					consumerBlock = getLoopPreHeader(consumerBlock, blockTree);

				latestBlock = latestBlock === null
					? consumerBlock
					: findLeastCommonAncestor(blockTree, latestBlock, consumerBlock);
			}
		}

		// Click's Core Sinking Choice:
		// Walk from the latest possible block up to the earliest possible block.
		// Pick the block with the lowest execution frequency (e.g., outside loops).
		const earliestBlock = blockIds.get(nodeId)!;
		let bestBlock = latestBlock || earliestBlock;
		let currentBlock = bestBlock;

		while (currentBlock !== earliestBlock) {
			currentBlock = blockTree.get(currentBlock)!; // Move up the dominator tree
			if (getLoopDepth(currentBlock) < getLoopDepth(bestBlock))
				bestBlock = currentBlock; // Found a shallower block (Hoisted out of loop!)
		}

		blockIds.set(nodeId, bestBlock);
	}
	for (const nodeId of graph.keys())
		scheduleLate(nodeId);

	// 4. Pack nodes into their final sequential block buckets
	const blocks = new Map<BlockId, BasicBlock>();

	for (const id of graph.keys()) {
		const bId = blockIds.get(id) || '';
		if (!blocks.has(bId))
			blocks.set(bId, {/*parent: blockTree.get(bId),*/ control: id, nodes: [] });
		blocks.get(bId)!.nodes.push(id);
	}
	return blocks;
}

export function blocksToAST(
	blocks:		Map<BlockId, BasicBlock>,
	blockIds:	Map<NodeId, BlockId>,
	graph:		Map<NodeId, Node>
): any[] {
	const output = new Output(graph);

	function emitBlockStatements(blockId: BlockId) {
		processedBlocks.add(blockId);
		return output.emitLocalStatements(blocks.get(blockId)!.nodes);
	}

	const statements: Statement[] = [];
	const processedBlocks = new Set<BlockId>();

	// 2. Iterate through the blocks in a linear sequential chain
	for (const blockId of blocks.keys()) {
		if (processedBlocks.has(blockId))
			continue;

		const block		= blocks.get(blockId)!;
		const control	= graph.get(block.control)!;

		// --- STRUCTURAL INTERCEPTION 1: IF / ELSE BRANCHES ---
		if (control.type === 'gamma') {
			// Isolate the specific blocks containing the branch calculations
			const trueBlockId	= blockIds.get(control.inputs[1].nodeId)!;
			const falseBlockId	= blockIds.get(control.inputs[2].nodeId)!;

			// Nest them cleanly within an IfStatement container
			statements.push(JS.If(Identifier(output.nodeVariableNames.get(control.inputs[0].nodeId)!),
				JS.Block(...emitBlockStatements(trueBlockId) as JS.Statement<any>[]),
				falseBlockId ? JS.Block(...emitBlockStatements(falseBlockId) as any) : undefined
			) as Statement);
		}

		// --- STRUCTURAL INTERCEPTION 2: WHILE LOOPS ---
		else if (control.type === 'mu') {
			// Locate the theta exit node feeding out of the loop block sequences
			const stateOutputs	= control.outputs[0] || [];
			const thetaExitEdge	= stateOutputs.find(e => graph.get(e.nodeId)!.type === 'theta');

			if (thetaExitEdge) {
				const thetaNode = graph.get(thetaExitEdge.nodeId)!;
				const loopConditionEdge = thetaNode.inputs[0];
				const conditionName = output.nodeVariableNames.get(loopConditionEdge.nodeId)!;

				// Follow Port 0 state output of the Mu to find the internal loop body block
				const loopBodyStateEdge = control.outputs[0].find(e => e.port === 0)!;
				const loopBodyBlockId = blockIds.get(loopBodyStateEdge.nodeId)!;

				// Nest them cleanly within a WhileStatement container
				statements.push(JS.While(Identifier(conditionName),
					JS.Block(...emitBlockStatements(loopBodyBlockId) as any)
				) as Statement);

				// Advance past the loop exit filter block to avoid duplicate leakage
				const thetaNodeWithBlock = thetaNode as any;
				if (thetaNodeWithBlock.blockId)
					processedBlocks.add(thetaNodeWithBlock.blockId);
			}
		}

		// --- STANDARD PATH: EMIT SEQUENTIAL STATEMENTS ---
		statements.push(...emitBlockStatements(blockId));
	}

	return statements;
}
