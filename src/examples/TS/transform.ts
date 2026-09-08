import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import { Identifier, Literal, Binary, Conditional, Assign, Await, Member, ExprStmt, hasMod, dropMod, If, While } from '../common';
import { Walkable, walk, walkB, calcUnary, calcBinary } from './walker';
import { SEVERITY, Err, checkBlock, checkStmt1, exportScope, typeOf, inferReturn } from './checker';
import { LoadedModule, ModuleLoader } from './module-loader';
import { Output } from './tocode';

type Location		= JS.Location;
type Expr			= JS.Expr;
type Stmt			= TS.Stmt;
type BindingTarget	= JS.BindingTarget;
type Type			= TS.Type;
type Scope			= T.Scope;
const Scope			= T.Scope;

//-----------------------------------------------------------------------------
// Constant folding
//-----------------------------------------------------------------------------

const typeMasks = {
	number:		1,
	bigint:		2,
	string:		4,
	boolean:	8,
	undefined:	16,
	symbol:		32,
	unknown:	0,
	object:		0,
	function:	0,
} as const;

export function foldConstants<T extends Walkable>(ast: T) {
	return walk(ast,
		undefined,
		(expr, process) => {
			expr = process(expr);
			switch (expr.type) {
				case 'literal': {
					if (Array.isArray(expr.value)) {
						const parts: JS.TemplatePart<Expr>[] = [];
						let current = '';
						for (const i of expr.value) {
							current += i.str;
							if (i.exp?.type === 'literal') {
								current += i.exp.value?.toString();
							} else {
								parts.push({str: current, exp: i.exp});
								current = '';
							}
						}
						if (parts.length === 0)
							return Literal(current);
						parts.push({str: current});
						return Literal(parts);
					}
					break;
				}
				case 'binary': {
					if (expr.left.type === 'literal' && expr.right.type === 'literal' && expr) {
						const r = calcBinary(expr.operator, expr.left.value, expr.right.value);
						if (r !== undefined)
							return Literal(r);
					}
					break;
				}
				case 'unary':
					if (expr.operand.type === 'literal') {
						const r = calcUnary(expr.operator, expr.operand.value);
						if (r !== undefined)
							return Literal(r);
					}
					break;

				case 'call':
					if (expr.arguments.every(a => a.type === 'literal')) {
						const args = expr.arguments.map(a => (a as Literal<any>).value);
						const arg0 = args[0];
						const mask = typeMasks[typeof arg0];
						if (expr.callee.type === 'identifier') {
							switch (expr.callee.name) {
								case 'Number':		return Literal(Number(arg0));
								case 'BigInt':		return mask & 15 ? Literal(BigInt(arg0)) : undefined;
								case 'String':		return mask & 15 ? Literal(arg0.toString()) : undefined;
								case 'Boolean':		return Literal(Boolean(arg0));
								case 'parseInt':	return mask === 4 ? Literal(parseInt(arg0)) : undefined;
								case 'parseFloat':	return mask === 4? Literal(parseFloat(arg0)) : undefined;
							}
						} else if (expr.callee.type === 'member' && expr.callee.object.type === 'identifier') {
							if (expr.callee.object.name === 'Math') {
								switch (expr.callee.property) {
									case 'abs':		return Literal(Math.abs(arg0));
									case 'floor':	return Literal(Math.floor(arg0));
									case 'ceil':	return Literal(Math.ceil(arg0));
									case 'round':	return Literal(Math.round(arg0));
									case 'fround':	return Literal(Math.fround(arg0));
									case 'max':		return Literal(Math.max(...args));
									case 'min':		return Literal(Math.min(...args));
									case 'pow':		return Literal(Math.pow(args[0], args[1]));
									case 'sqrt':	return Literal(Math.sqrt(arg0));
									case 'sin':		return Literal(Math.sin(arg0));
									case 'cos':		return Literal(Math.cos(arg0));
									case 'tan':		return Literal(Math.tan(arg0));
									case 'asin':	return Literal(Math.asin(arg0));
									case 'acos':	return Literal(Math.acos(arg0));
									case 'atan':	return Literal(Math.atan(arg0));
									case 'atan2':	return Literal(Math.atan2(args[0], args[1]));
									case 'exp':		return Literal(Math.exp(arg0));
									case 'log':		return Literal(Math.log(arg0));
									case 'log10':	return Literal(Math.log10(arg0));
									case 'log2':	return Literal(Math.log2(arg0));
									case 'trunc':	return Literal(Math.trunc(arg0));
									case 'sign':	return Literal(Math.sign(arg0));
									case 'sinh':	return Literal(Math.sinh(arg0));
									case 'cosh':	return Literal(Math.cosh(arg0));
									case 'tanh':	return Literal(Math.tanh(arg0));
									case 'asinh':	return Literal(Math.asinh(arg0));
									case 'acosh':	return Literal(Math.acosh(arg0));
									case 'atanh':	return Literal(Math.atanh(arg0));
									case 'log1p':	return Literal(Math.log1p(arg0));
									case 'cbrt':	return Literal(Math.cbrt(arg0));
									case 'hypot':	return Literal(Math.hypot(...args));
									case 'imul':	return Literal(Math.imul(args[0], args[1]));
									case 'clz32':	return Literal(Math.clz32(arg0));
								}
							}
						}
					}
					break;
					
				case 'conditional':
					if (expr.test.type === 'literal')
						return expr.test.value ? expr.consequent : expr.alternate;
					break;
			}
			return expr;
		},
		undefined
	);
}

//-----------------------------------------------------------------------------
// State-machine flattening (generators/async functions)
//-----------------------------------------------------------------------------

// Every plain-identifier local a generator/async function's own body declares via `var_decl` (its
// enclosing statement kept alongside, for its own checker-stamped scope -- see towasm.ts's own
// `compileGeneratorFunc`, which needs it to resolve each local's type the same way `case 'var_decl'`
// does) -- stops at a nested closure boundary, whose locals belong to *that* function, not this one.
// towasm.ts hoists every one of these into the resumable step function's frame (no precise liveness
// analysis -- conservative, but simple and correct: a local that never actually crosses a suspend
// point just costs an unused frame field). A destructured declarator ('const {a,b} = x') is skipped
// here -- real, but narrower and deferred; only a plain 'let x = ...'/'const x = ...' is hoisted.
export function collectHoistedLocals(body: Stmt[]): Map<string, { stmt: Stmt; decl: JS.Var<Type> }> {
	const decls = new Map<string, { stmt: Stmt; decl: JS.Var<Type> }>();
	walkB(body,
		(s, process) => {
			if (s.type === 'var_decl') {
				for (const d of s.declarations) {
					if (typeof d.name === 'string' && !decls.has(d.name))
						decls.set(d.name, { stmt: s, decl: d });
				}
			}
			return process(s);
		},
		(e, process) => (e.type === 'arrow' || e.type === 'function') ? false : process(e)
	);
	return decls;
}

// A suspend point recognized directly in statement position -- v1's only supported shape. A
// `yield`/`await` embedded anywhere else inside a larger expression ('foo(yield x)', '(await p) +
// 1', ...) is rejected by `containsSuspend` below rather than silently mishandled.
export interface SuspendBoundary {
	kind: 'yield' | 'await';
	operand?:	Expr;
	delegate?:	boolean;	// 'yield*' -- recognized here so it isn't caught by the generic "nested" rejection below; towasm.ts's own consumer currently still rejects delegation itself (a separate, later gap).
	resultVar?:	string;		// set when the source binds the resumed/settled value directly: 'const v = yield x;' / 'const v = await p;'
}

// Every transition out of a segment is one of these -- 'goto'/'branch' are the state-machine
// equivalent of an unconditional/conditional jump (real control flow, not structured wasm nesting,
// since a *resumed* call has none of the original call's block/loop context left -- see towasm.ts's
// own 'emitGeneratorDispatch'). 'complete' is the single shared "done" landing point: reached once,
// by whatever naturally falls off the function's own end, and again by every subsequent call.
export type SegmentNext =
	| { type: 'goto';		target: number }
	| { type: 'branch';		test: Expr; then: number; else: number }
	| { type: 'suspend';	resumeId: number } & SuspendBoundary
	| { type: 'complete' };

export interface StateMachineSegment {
	id:			number;
	stmts:		Stmt[];
	next:		SegmentNext;
}

export interface StateMachine {
	segments:	StateMachineSegment[];
	entryId:	number;
	completeId:	number;
}

// Splits a generator/async function's body into a flat, id-addressable graph of segments --
// towasm.ts's 'emitGeneratorDispatch' turns this into one resumable step function (a dispatch + one
// nested block per segment, the same shape 'case switch' already lowers a real switch statement to,
// wrapped in one more outer 'loop' so a 'goto'/'branch' transition can redispatch instead of relying
// on structured block nesting, which a *resumed* call has none of). Pure AST-in/out, no wasm
// concepts. `containsSuspend`/`isFlattenable` reject anything not directly expressible this way (a
// suspend point embedded in a larger expression, or nested inside a 'switch'/'try') with a clear
// error rather than silently mishandling it.

export function BuildStateMachine(stmts: Stmt[]) {
	const segments = [] as (StateMachineSegment | undefined)[];

	function reserve(): number {
		return segments.push(undefined) - 1;
	}
	function define(id: number, stmts: Stmt[], next: SegmentNext) {
		segments[id] = { id, stmts, next };
	}

	function suspendExpr(e: Expr): SuspendBoundary | undefined {
		return e.type === 'yield' ? { kind: 'yield', operand: e.operand, delegate: e.delegate }
			: e.type === 'await' ? { kind: 'await', operand: e.operand }
			: undefined;
	}

	// The only statement shapes v1 recognizes as a suspend boundary:
	// - a bare 'yield x;'/'await p;'
	// - expression statement, 'return await p;'
	// - a single-declarator 'const v = yield x;'/'= await p;'.
	function suspendBoundary(stmt: Stmt): SuspendBoundary | undefined {
		if (stmt.type === 'expression')
			return suspendExpr(stmt.expression);
		if (stmt.type === 'return' && stmt.argument) {
			// 'return (yield x)' isn't recognized here (only 'return await p;') -- real but rare, deferred.
			const b = suspendExpr(stmt.argument);
			return b?.kind === 'await' ? b : undefined;
		}
		if (stmt.type === 'var_decl' && stmt.declarations.length === 1) {
			const d = stmt.declarations[0];
			if (typeof d.name === 'string' && d.init) {
				const b = suspendExpr(d.init);
				if (b)
					return { ...b, resultVar: d.name };
			}
		}
		return undefined;
	}

	// Stops at a nested closure boundary (a yield/await inside it belongs to *that* function, not this one)
	function containsSuspend(stmt: Stmt): boolean {
		return walkB(stmt,
			undefined,
			(e, process) => suspendExpr(e as Expr) ? true : (e.type === 'arrow' || e.type === 'function') ? false : process(e)
		);
	}

	// A bare (unlabeled -- labeled break/continue is unsupported everywhere else in towasm.ts too) break
	// or continue that would target the loop/switch containing `stmts` directly, not a nested one (which
	// establishes its own break/continue scope, same reasoning `case 'switch'`'s own scoping needs).
	function containsOwnBreakOrContinue(stmts: Stmt|Stmt[]): boolean {
		return walkB(stmts,
			(s, process) => {
				if (s.type === 'break' || s.type === 'continue')
					return true;
				if (s.type === 'while' || s.type === 'do_while' || s.type === 'for' || s.type === 'switch')
					return false;
				return process(s);
			},
			(e, process) => (e.type === 'arrow' || e.type === 'function') ? false : process(e)
		);
	}

	function bodyStmtsOf(stmt: Stmt): Stmt[] {
		return stmt.type === 'block' ? stmt.body : [stmt];
	}

	// Flattens `stmts`, returning the id of its own entry segment. `contId`: where control goes once `stmts` completes normally (falls off its own end)
	// -- always a real, already-known id (the whole point of processing backward below: by the time a statement is handled, everything textually after
	// it is already built, so its own "what happens next" is always a concrete target, never a forward reference needing a later patch-up).
	function recurse(stmts: Stmt[], contId: number): number {
		let cont = contId;
		let trailing: Stmt[] = [];	// ordinary statements seen so far, nearest-to-`cont` first
		const flush = (): number => {
			if (trailing.length === 0)
				return cont;
			const id = reserve();
			define(id, trailing.reverse(), { type: 'goto', target: cont });
			trailing = [];
			cont = id;
			return id;
		};
		for (let i = stmts.length - 1; i >= 0; i--) {
			const stmt = stmts[i];
			const boundary = suspendBoundary(stmt);
			if (boundary) {
				const id = reserve();
				define(id, [], { ...boundary, type: 'suspend', resumeId: flush() });
				cont = id;

			} else if (containsSuspend(stmt)) {
				switch (stmt.type) {
					case 'block':
						cont = recurse(stmt.body, flush());
						break;

					case 'if': {
						const cont0 = flush();
						cont = reserve();
						define(cont, [], {
							type: 'branch', test: stmt.test,
							then: recurse(bodyStmtsOf(stmt.consequent), cont0),
							else: stmt.alternate ? recurse(bodyStmtsOf(stmt.alternate), cont0) : cont0,
						});
						break;
					}
					case 'while': {
						if (containsOwnBreakOrContinue(stmt.body))
							throw new Error("'break'/'continue' inside a yield-containing loop is not yet supported");
						const cont0 = flush();
						cont = reserve();
						define(cont, [], { type: 'branch', test: stmt.test, then: recurse(bodyStmtsOf(stmt.body), cont), else: cont0 });
						break;
					}
					case 'do_while': {
						if (containsOwnBreakOrContinue(stmt.body))
							throw new Error("'break'/'continue' inside a yield-containing loop is not yet supported");
						const cont0		= flush();
						const testId	= reserve();
						cont = recurse(bodyStmtsOf(stmt.body), testId);
						define(testId, [], { type: 'branch', test: stmt.test, then: cont, else: cont0 });
						break;
					}
					case 'for': {
						if (containsOwnBreakOrContinue(stmt.body))
							throw new Error("'break'/'continue' inside a yield-containing loop is not yet supported");
						const cont0		= flush();
						cont = reserve();
						const updateId	= reserve();
						const bodyEntry = recurse(bodyStmtsOf(stmt.body), updateId);
						switch (stmt.kind) {
							case 'normal':
								define(updateId, stmt.update ? [{ type: 'expression', expression: stmt.update } as Stmt] : [], { type: 'goto', target: cont });
								define(cont, [], stmt.test ? { type: 'branch', test: stmt.test, then: bodyEntry, else: cont0 } : { type: 'goto', target: bodyEntry });
								break;
						}
						if (stmt.init) {
							const cont2 = reserve();
							define(cont2, [stmt.init.type === 'var_decl' ? stmt.init : { type: 'expression', expression: stmt.init } as Stmt], { type: 'goto', target: cont });
							cont = cont2;
						}
						break;
					}
					default:
						throw new Error("a yield/await here is not yet supported (only a bare 'yield x;'/'await x;' statement, 'return await x;', 'const v = yield x;', or one of those nested in a plain 'if'/'while'/'do..while'/'for' -- not embedded in a larger expression, and not inside a 'switch'/'try')");
				}

			} else {
				trailing.push(stmt);
			}
		}
		return flush();
	}
	const completeId	= reserve();
	const entryId		= recurse(stmts, completeId);
	define(completeId, [], { type: 'complete' });

	return {
		entryId, completeId,
		segments: segments.map((s, id) => {
			if (!s)
				throw new Error(`internal: state-machine segment ${id} was reserved but never defined`);
			return s;
		}),
	};
}


// Debug/visualization only: renders a `StateMachine` back into a plain, printable JS AST -- a
// `while (true) { switch (state) { ... } }` dispatch loop -- so `Output.toCode` can show exactly
// which segment runs, what it does, and where it goes next. Not real codegen (towasm.ts's own
// 'emitGeneratorDispatch' lowers the same graph straight to wasm instead); a suspend is rendered
// as `state = resumeId; return yield/await x;` since that's the clearest way to show "control
// leaves here and re-enters at resumeId" as source text.
export function StateMachineToAST(machine: StateMachine) {
	type S = Stmt;
	const state		= Identifier('state');
	const setState	= (v: number): S => ExprStmt(Assign<Expr, JS.assignableOps>(state, Literal(v)));
	const cont: S	= {type: 'continue'};

	// a suspend's `resultVar` ('const v = yield x;') is bound only once control resumes, so it's
	// stashed here and re-materialized as a `let` at the top of the segment it resumes into.
	const resultVars = new Map<number, string>();
	for (const seg of machine.segments)
		if (seg.next.type === 'suspend' && seg.next.resultVar)
			resultVars.set(seg.next.resumeId, seg.next.resultVar);
	const resumeValue = Identifier('$resume');

	return JS.Block<S>(
		JS.VarDecl<Type>('let', JS.Var<Type>('state', Literal(machine.entryId))),
		While(Literal(true), JS.Block<S>(JS.Switch<S>(state, ...machine.segments.map((seg, k) => {
			const stmts: S[] = [];
			const resultVar = resultVars.get(k);
			if (resultVar)
				stmts.push(JS.VarDecl<Type>('let', JS.Var<Type>(resultVar, resumeValue)));
			stmts.push(...seg.stmts);

			const next = seg.next;
			switch (next.type) {
				case 'goto':
					stmts.push(
						setState(next.target),
						cont
					);
					break;

				case 'branch':
					stmts.push(
						If(next.test,
							JS.Block<S>(setState(next.then)),
							JS.Block<S>(setState(next.else))
						),
						cont
					);
					break;

				case 'suspend': {
					if (next.delegate)
						throw new Error("'yield*' delegation is not supported");
					stmts.push(setState(next.resumeId));
					stmts.push(JS.Return(next.kind === 'yield'
						? { type: 'yield', operand: next.operand, delegate: next.delegate }
						: Await(next.operand!)
					));
					break;
				}

				case 'complete':
					stmts.push(JS.Return());
					break;
			}
			return JS.SwitchCase(Literal(k), ...stmts);
		}))))
	);
}


// Desugars a destructuring BindingTarget into flat var_decls reading off valueExpr (must be side-effect-free).
// A default value (`el.default`/`prop.default`) just becomes a real `??` (`rawExpr ?? dflt`) -- reuses
// `??`'s own codegen wholesale, including its single-evaluation-of-the-left materialization, rather than
// hand-rolling a second copy of that logic here. `??`'s codegen also needs to tolerate a non-nullable
// left for this to work (see its own comment) -- a default on an already-non-nullable value (an ordinary
// array element, or a non-optional object field) is provably dead code, same as real TS itself would
// prove, not a reason to reject it.
export function patternBindings(kind: JS.DeclarationKind, target: BindingTarget, valueExpr: Expr): JS.Stmt<Type>[] {
	if (typeof target === 'string')
		return [JS.VarDecl(kind, JS.Var(target, valueExpr))];

	if (target.type === 'array_pattern') {
		const stmts = target.elements.flatMap((el, i) => {
			if (!el)
				return [];
			const elemExpr: Expr = JS.Index(valueExpr, Literal(i));
			// A default is LENGTH-guarded, not `?? default`: the pattern can be longer than the value
			// (`const [a, b = 7] = [1]`, entirely ordinary JS), and reading past the end traps in wasm
			// rather than giving `undefined`, so `??` never got the chance to supply the default.
			return patternBindings(kind, el.target, el.default
				? Conditional<Expr>(Binary<Expr, '<'>('<', Literal(i), JS.Member(valueExpr, 'length')), elemExpr, el.default)
				: elemExpr);
		});
		if (target.rest) {
			// Real JS semantics: the rest collects the remaining elements into a genuinely new array, not
			// a view -- `.slice(n)` (already a real `Array<T>` method) gives exactly that.
			stmts.push(JS.VarDecl(kind, JS.Var(target.rest, JS.Call(JS.Member(valueExpr, 'slice'), [Literal(target.elements.length)]))));
		}
		return stmts;
	}

	if (target.rest)
		throw "a rest property ('...') in an object destructuring pattern is not supported -- unlike array rest (a plain '.slice()'), this needs a genuinely new object type holding an arbitrary 'all fields except these' shape, which isn't modeled yet";
	
	return target.properties.flatMap(prop => {
		if (typeof prop.key !== 'string')
			throw "a computed key ('[expr]') in an object destructuring pattern is not supported";
		const propExpr: Expr = JS.Member(valueExpr, prop.key);
		return patternBindings(kind, prop.value, prop.default ? Binary('??', propExpr, prop.default) : propExpr);
	});
}

//-----------------------------------------------------------------------------
// TS to JS
//-----------------------------------------------------------------------------

const dropOptional = (p: JS.Param<any>) => dropMod(p, 'optional');

export function TStoJS(ast: TS.Program) {
	return walk(ast, 
		//onStatement
		(stmt, process) => {
			switch (stmt.type) {
				case 'type_alias_decl':
				case 'interface_decl':
				case 'namespace_decl':
					return undefined;

				case 'export_decl':
					stmt = process(stmt);
					return stmt.declaration ? stmt : undefined;

				case 'function_decl':
					if (!stmt.body)
						return undefined;
					stmt = process(stmt);
					stmt.params.forEach(dropOptional);
					return stmt;

				case 'enum_decl': {
					stmt = process(stmt);
					let next = 0;
					return JS.VarDecl('const', {
						name: stmt.name,
						init: JS.ObjectExpr(stmt.members.map(m => {
							let value: Expr;
							if (m.init) {
								value = m.init;
								next = T.isLiteral(m.init, 'number') ? m.init.value + 1 : NaN;
							} else {
								value = Literal(next++);
							}
							return JS.Field(m.name, value);
						})),
					});
				}
				
				case 'var_decl':
					return stmt.ambient ? undefined : process(stmt);

				case 'class_decl':
					if (stmt.ambient)
						return undefined;
					stmt = process(stmt);
					stmt.body.forEach(m => {
						if (m.type === 'field') {
							delete m.modifiers;

						} else if (m.type === 'method') {
							if (m.key === 'constructor') {
								// A parameter-property modifier is anything but the unrelated `'optional'` tag
								// that can now also live in `modifiers` (see `Param`'s own comment).
								const prelude: JS.Stmt<any>[] = m.params
									.filter((p) => p.modifiers?.some(x => x !== 'optional'))
									.map(p => ({
										type: 'expression',
										expression: Assign<Expr, JS.assignableOps>(
											Member<Expr>({ type: 'this' }, p.key as string),
											Identifier(p.key as string),
										),
									})
								);
								if (prelude.length)
									m.body = [...prelude, ...m.body!];
							}

							for (const p of m.params)
								delete p.modifiers;
							delete m.modifiers;
						}
					});
					delete stmt.typeParams;
					delete stmt.implements;
					delete stmt.abstract;
					return stmt;

				default:
					return process(stmt);
			}

		},
		//onExpr
		(expr, process, recurse) => {
			switch (expr.type) {

				case 'function':
					expr = process(expr)!;
					expr.params.forEach(dropOptional);
					return expr;

				case 'arrow':
					expr = process(expr)!;
					expr.params.forEach(dropOptional);
					return expr;

				case 'class':
					return {...process(expr)!, typeParams: undefined, implements: undefined, abstract: undefined};

				case 'as':
				case 'satisfies':
				case 'instantiation':
					return recurse(expr.expression);

				case 'unary_post':
					return expr.operator === '!' ? recurse(expr.operand) : process(expr);

				default:
					return process(expr);
			}
		},
		//onType
		(_type, _process) => undefined
	);
}

// ===================================================================
//  TStypeCheck
// ===================================================================

export interface Diagnostic {
	severity:	SEVERITY;
	pos:		Location;
	message:	string;
}

function makeDiagnostic(func: (d: Diagnostic) => void): Err {
	const renderer	= new Output;
	const clip		= (s: string, max = 60)	=> s.length > max ? s.slice(0, max - 3) + '...' : s;
	const toString	= (v: any) => v === undefined ? '' : typeof v === 'string' ? v : renderer.toCode(v);

	return (severity: SEVERITY, pos: JS.Location) => (strings: TemplateStringsArray, ...values: any[]) => func({
		severity,
		message: ['GAP', 'WRN', 'ERR'][severity] + ': ' + strings.map((s, i) => s + clip(toString(values[i]))).join(''),
		pos
	});
}

// Folds any depth-budget hits from type-utils.ts's structural recursion into one summary GAP diagnostic, not one per occurrence.
function pushDepthExhaustionGap(depthHits: Map<string, number>, diagnostics: Diagnostic[]) {
	if (depthHits.size) {
		diagnostics.push({
			severity: SEVERITY.GAP,
			pos: { line: 1, col: 1 },
			message: 'GAP: recursion depth limit reached during structural type resolution ('
				+ [...depthHits].map(([fn, n]) => `${fn}×${n}`).join(', ')
				+ ') -- some assignability/member checks may be incomplete',
		});
	}
}

// `libScope`: a scope populated with lib declarations a later consumer needs in view while checking
// this program (e.g. `TStoWasm`'s `makeLibScope()`, for `String`/`RegExpMatch`/etc) -- `global` (and so
// every statement's own checked-under scope, and `ast.scope` itself) descends from it when given, so
// that consumer doesn't need to re-check the program a second time just to see those declarations from
// a scope its own code actually reaches. Optional and defaults to a bare `T.makeGlobal()`, unchanged
// from before, for callers with no such consumer (e.g. `TStoDecl`-only or checker-only use).
export function TStypeCheck(ast: TS.Program, global: Scope): Diagnostic[] {
	const depthExhaustion = new Map<string, number>();
	global.hitDepthLimit = fn => depthExhaustion.set(fn, (depthExhaustion.get(fn) ?? 0) + 1);

	const diagnostics: Diagnostic[] = [];
	checkBlock(ast.body, global, undefined, checkStmt1(makeDiagnostic(d => diagnostics.push(d))));
	pushDepthExhaustionGap(depthExhaustion, diagnostics);
	ast.scope = global;
	return diagnostics;
}

// `tainted`: this build (or one it awaited) had to skip something to avoid deadlocking on a genuine import cycle -- real and usable, just incomplete.
interface ModuleShape { scope: Scope; value: Type; tainted: boolean }

// Process-wide, like `libScopeCache`. A genuine cycle (e.g. Node's `fs`<->`fs/promises` `.d.ts` graph) truncates
// whichever side asks second; `tainted` marks that so it's evicted instead of poisoning later callers.
const importScopeCache	= new Map<LoadedModule, Promise<ModuleShape>>();
const waitingFor		= new Map<LoadedModule, Set<LoadedModule>>();

// Own declarations recorded before re-export merging (the part that can cycle) -- lets a plain `import`'s deadlock
// fallback (`awaitScope`'s `fallbackToOwn`) resolve from here instead, since imports never need re-exports.
const ownScopeSettled	= new Map<LoadedModule, { scope: Scope; alias?: Type }>();

function wouldDeadlock(waiter: LoadedModule, target: LoadedModule): boolean {
	const seen = new Set<LoadedModule>([target]);
	const stack = [target];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === waiter)
			return true;
		for (const next of waitingFor.get(cur) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return false;
}

async function safely<T>(waiter: LoadedModule, target: LoadedModule, func: () => Promise<T>): Promise<T | undefined> {
	if (wouldDeadlock(waiter, target))
		return undefined;

	let waits = waitingFor.get(waiter);
	if (!waits)
		waitingFor.set(waiter, waits = new Set());
	waits.add(target);
	try {
		return await func();
	} finally {
		waits.delete(target);
	}
}

export async function loadLib(loader: ModuleLoader, libs: string[]): Promise<T.Scope> {
	const global	= T.makeGlobal();
	for (const spec of libs!) {
		const lib = await loader.get(spec, '.');
		if (lib)
			checkBlock(lib.body, global);
	}
	return global;
}

// `libScope`: see `TStypeCheck`'s own comment -- same purpose here, but only chained in as an extra
// ancestor on top of whatever `options.lib` already loads (not merged with it); no current caller needs
// both a real module-loaded lib set *and* a `TStoWasm`-style `libScope` at once, so a real combination
// (e.g. copying `libScope`'s own bindings into the loaded scope) is left for whenever one actually does.
export async function TStypeCheckAsync(program: TS.Program, loader: ModuleLoader, global: Scope) {
	const diagnostics: Diagnostic[] = [];

	// Resolves one `import` into `importScope` (shared by `makeScope` and the entry program); return value feeds
	// `makeScope`'s own `tainted` verdict (false = cycle truncation).
	const resolveImport = async (waiter: LoadedModule, importScope: Scope, imp: JS.Import, from: string): Promise<boolean> => {
		const impSrc = await loader.get(imp.source, from);
		if (!impSrc) {
			diagnostics.push({ severity: 1, pos: (imp as any).pos, message: `Could not resolve import '${imp.source}'` });
			return true;	// unresolvable specifier, not a cycle -- nothing for `makeScope` to retry later
		}
		let resolved = await safely(waiter, impSrc, () => makeScope(impSrc));
		if (!resolved) {
			const own = ownScopeSettled.get(impSrc);
			if (!own)
				return false;	// genuine import cycle -- contribute nothing further rather than deadlock
			resolved = { scope: own.scope, value: own.alias ?? own.scope.toObject(), tainted: true };
		}

		const { scope: impScope, value } = resolved;

		// `import X from 'mod'` (default import) -- independent of `namespace`/`specifiers` below (`import X, {y} from 'mod'` and
		// `import X, * as NS from 'mod'` both combine a default with the other form in the same statement). `checker.exportScope`
		// registers a module's default export under the literal key `'default'`; this is the only place that key is read back.
		if (imp.default)
			importScope.copy(impScope, 'default', imp.default, imp.typeOnly);

		if (imp.namespace) {
			importScope.addValue(imp.namespace, value);
			importScope.addNamespace(imp.namespace, impScope);
		} else {
			for (const spec of imp.specifiers ?? [])
				importScope.copy(impScope, spec.imported, spec.local, spec.typeOnly || imp.typeOnly);
		}
		return !resolved.tainted;
	};

	// Returns `src`'s exported symbols as one `Scope`; also resolves `export ... from` re-exports here, since only
	// this has the loader that `checker.exportScope` doesn't.
	async function makeScope(src: LoadedModule): Promise<ModuleShape> {
		const existing = importScopeCache.get(src);
		if (existing)
			return existing;

		const importScope = new Scope(global);
		const cached = Promise.all(src.body.filter(s => s.type === 'import').map(s => resolveImport(src, importScope, s, src.canonical))).then(async imports => {
			let tainted = imports.some(clean => !clean);
			const { scope, alias } = exportScope(src.body, importScope);
			// Recorded before the (possibly cyclic) re-export loop awaits anything -- see `ownScopeSettled` for why placement matters.
			ownScopeSettled.set(src, { scope, alias });
			for (const stmt of src.body) {
				if (stmt.type !== 'export' || !stmt.source)
					continue;
				const target = await loader.get(stmt.source, src.canonical);
				if (!target)
					continue;
				const targetShape = await safely(src, target, () => makeScope(target));
				if (!targetShape) {
					tainted = true;
					continue;	// genuine circular re-export chain -- contribute nothing further rather than deadlock/recurse forever
				}
				tainted ||= targetShape.tainted;

				if (stmt.namespace) {
					// `export * as name from './x'`: one property holding the target's whole shape.
					scope.addValue(stmt.namespace, targetShape.value);
					scope.addNamespace(stmt.namespace, targetShape.scope);

				} else if (stmt.specifiers) {
					for (const spec of stmt.specifiers)
						scope.copy(targetShape.scope, spec.local, spec.exported, stmt.typeOnly || spec.typeOnly);
				} else {
					// bare `export * from './x'`: everything, as-is
					scope.copyAll(targetShape.scope, stmt.typeOnly);
				}
			}
			// `toObject()` here, after the re-export loop -- the flattened value type has to include everything
			// `export ... from` just merged in, not just what the module's own body declared.
			return { scope, value: alias ?? scope.toObject(), tainted };
		});
		importScopeCache.set(src, cached);
		// Caches only clean builds; a tainted one stays valid for concurrent awaiters, then gets evicted (identity-checked,
		// so a stale rebuild can't clobber a newer entry) so the next caller gets a fresh attempt.
		cached.then(result => {
			if (result.tainted && importScopeCache.get(src) === cached)
				importScopeCache.delete(src);
		});
		return cached;
	}

	// The entry program never goes through `makeScope` (nothing imports it) -- just its own stable identity for `wouldDeadlock`'s bookkeeping.
	const entrySrc: LoadedModule = { body: program.body, canonical: '.' };
	const entryScope = new Scope(global);
	// A SCRIPT (no top-level import/export) declares into the global space -- see `Scope.globalSpace`.
	entryScope.globalSpace = !program.body.some(s => s.type === 'import' || s.type === 'export' || s.type === 'export_decl' || s.type === 'export_assignment');
	await Promise.all(program.body.filter(s => s.type === 'import').map(s => resolveImport(entrySrc, entryScope, s, '.')));

	const depthExhaustion = new Map<string, number>();
	global.hitDepthLimit = fn => depthExhaustion.set(fn, (depthExhaustion.get(fn) ?? 0) + 1);
	checkBlock(program.body, entryScope, undefined, checkStmt1(makeDiagnostic(d => diagnostics.push(d))));
	pushDepthExhaustionGap(depthExhaustion, diagnostics);
	program.scope = entryScope;
	return diagnostics;
}

// ===================================================================
//  TStoDecl -- TypeScript AST to a .d.ts-shaped AST
// ===================================================================

export const OutputOptionsDefault = {
	declaration:							false,
	declarationDir:							undefined,
	declarationMap:							undefined,
	downlevelIteration:						undefined,
	emitBOM:								undefined,
	emitDeclarationOnly:					undefined,
	importHelpers:							undefined,
	inlineSourceMap:						undefined,
	inlineSources:							undefined,
	mapRoot:								undefined,
	newLine:								'\n',
	noEmit:									undefined,
	noEmitHelpers:							undefined,
	noEmitOnError:							undefined,
	outDir:									undefined,
	outFile:								undefined,
	preserveConstEnums:						undefined,
	removeComments:							undefined,
	sourceMap:								undefined,
	sourceRoot:								undefined,
	stripInternal:							undefined,
};

// The type-node kinds `T.resolve` can actually simplify -- constructs with no printable name of their own
// (unlike a plain `ref`, which should stay a name rather than get flattened to its structural body).
const RESOLVABLE = new Set(['mapped', 'conditional', 'indexed_access', 'keyof', 'typeof']);

// Combines two passes over the printed type tree, since `walk` takes one `onType` callback:
//  1. Requalifies a `ref` pointing at another module's scope (e.g. an inferred type naming an unexported
//     helper) through whatever namespace import reaches it, or inlines it in place if nothing does.
//  2. Resolves otherwise-unprintable constructs (`mapped`/`conditional`/`indexed_access`/`keyof`/`typeof`)
//     to their structural result via `T.resolve` -- the tison analogue of a tsc transform calling
//     `typeChecker.typeToTypeNode` instead of re-emitting the raw syntax.
// Plain named refs (interfaces/classes/type aliases) are deliberately left as names rather than expanded --
// matches real declaration emit (which preserves alias identity) and avoids flattening self-referential types.

function resolveTypes(entryScope: Scope, importScope: Scope | undefined) {
	// Tracks (alias, first type-argument) pairs currently on the inline/resolve stack -- not "ever expanded",
	// since a type can be self/mutually recursive and re-entering it while still expanding would loop forever.
	// Keyed on the *argument* too, not just the alias: a generic like `ReadType<T>` legitimately re-enters
	// itself once per nested field with a *different* T -- that's ordinary finite recursion, not a cycle: only
	// re-entering with the exact same argument is. The argument is keyed by `T.typeKey` (structural, printed-code
	// equality), not object identity -- `T.substituteType` builds a fresh object at every instantiation step even
	// when the same logical type genuinely recurs, so a reference-identity key would never catch a real cycle.
	const inlining = new Map<Type, Set<string | undefined>>();
	let depth = 0;	// nesting depth across *all* active inlines, not per-alias -- distinct from the per-(alias,argument) cycle check just above: bounds legitimately deep but finite recursion (real generic helper libraries chain many distinct instantiations), which the cycle check alone wouldn't catch since each level's argument genuinely differs.
	let scope = entryScope;	// ambient scope for scope-less constructs (`typeof`, `mapped`'s `keyof` &c) -- tracks whichever module's body we're currently inlining through

	// Thrown when a computed-type unwrap's own cycle guard (or the depth cap) fires (see the `RESOLVABLE` branch
	// below) -- caught only by the top-level call that started the chain, which reverts to printing the original
	// ref rather than committing to a partial expansion that dangles on an inaccessible self-recursive helper
	// (e.g. a computed type built from a discriminated union of specs, recursing through an unexported helper).
	class ComputedCycle {}

	const MAX_DEPTH = 40;

	return (type: Type, process: (t: Type, recall?: boolean) => Type | undefined): Type | undefined => {
		if (type.type === 'ref' && type.declScope) {
			const declScope	= type.declScope as Scope;
			const entry		= declScope.lookupType(type.name);
			if (entry) {
				// Requalifies this ref through whatever namespace import reaches it (e.g. `ReadType` -> `bin.ReadType`),
				// or down to its bare leaf name if that alone already reaches it unqualified (e.g. a type declared in
				// *this* module but referenced via `pe.PE` from within a signature written in some other module that
				// imports this one as a namespace -- printed from this module's own perspective, `pe.` would be circular
				// nonsense). Tried whenever we're not going to fully unwrap the ref in place -- either because its body
				// isn't a nameless computed construct to begin with, or because unwrapping it bailed on a cycle/depth-
				// exhaustion -- so neither the wrong qualifier nor a fully-bare foreign name ends up in the output just
				// because the unwrap attempt gave up partway through.
				const requalify = (): Type | undefined => {
					if (!importScope)
						return undefined;
					const leaf = type.name.split('.').pop()!;
					// Reference-identity match, same as `findQualifiedPath` -- the normal case.
					if (importScope.type(leaf)?.type === entry.type)
						return leaf === type.name ? process(type) : process(TS.RefType(leaf, type.typeArgs));
					const path = importScope.findQualifiedPath(leaf, entry.type);
					if (path)
						return process(TS.RefType([...path, leaf].join('.'), type.typeArgs));
					// Neither matched by identity -- a genuine import cycle (this module importing, directly or
					// transitively, whatever declared `type`) settles one side for an independently-checked view
					// of the other, so a *type declared in this very module* can come back as a non-identical
					// object when referenced from within the cyclic partner. Same leaf name in this module's own
					// top-level scope is as good a signal as we get short of structural equality -- print bare.
					return importScope.type(leaf) ? process(TS.RefType(leaf, type.typeArgs)) : undefined;
				};

				// A ref whose own declared body is itself a nameless "computed" construct (mapped/conditional/&c,
				// e.g. a type-level function like `bin.ReadType<T>`) never gets a stable printable identity in
				// real TS either -- unwrap it one level rather than printing a name that just hides the
				// computation the reader actually wants to see.
				// `topLevel`/the try-catch wrap *both* branches below, not just the `RESOLVABLE` one -- a
				// `ComputedCycle` thrown deep inside a foreign/unreachable (`else`-branch) inline still has to
				// unwind to here, since that branch's own `inlineEntry` call has nothing to catch it locally.
				const topLevel = inlining.size === 0;
				try {
					const resolvable = RESOLVABLE.has(entry.type.type);
					if (!resolvable) {
						const r = requalify();
						if (r !== undefined)
							return r;
					}

					// Substitutes `typeArgs` into `entry`'s declared body and recurses into it -- cycle-guarded, since an
					// unexported or computed type can be self/mutually recursive. `bail`: throw `ComputedCycle` instead of
					// quietly stopping, for the `RESOLVABLE` chain, which has nothing sensible to fall back to mid-expansion.

					const argKey	= type.typeArgs?.[0] && T.typeKey(type.typeArgs[0]);
					const active	= inlining.get(entry.type);
					if (active?.has(argKey) || depth >= MAX_DEPTH) {
						if (resolvable)
							throw new ComputedCycle;
					} else {
						const set = active ?? new Set<string | undefined>();
						if (!active)
							inlining.set(entry.type, set);
						set.add(argKey);
						++depth;
						const savedScope = scope;
						scope = declScope;
						try {
							return process(entry.typeParams?.length
								? T.substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, type.typeArgs?.[i] ?? p.default ?? T.ANY])))
								: entry.type
								, true);
						} finally {
							scope = savedScope;
							--depth;
							set.delete(argKey);
							if (!set.size)
								inlining.delete(entry.type);
						}
					}
				} catch (e) {
					if (!topLevel || !(e instanceof ComputedCycle))
						throw e;
					// The resolvable unwrap bailed -- still worth requalifying (e.g. `ReadType` -> `bin.ReadType`)
					// before giving up to the original, possibly-unreachable-as-written bare ref.
					const r = requalify();
					if (r !== undefined)
						return r;
				}
			}
			return process(type);
		}

		if (RESOLVABLE.has(type.type)) {
			// `stopAtRef` -- once resolution bottoms out at a named type (e.g. a conditional's chosen branch is just
			// `MappedMemory`), print that name rather than recursing one hop further into its structural body.
			const resolved = T.resolve(scope, type, undefined, true);
			if (resolved !== type) {
				const found = scope.findDeclaredName(resolved);
				return process(found ? T.withScope(TS.RefType(found.name), found.scope) : resolved, true);	// recall
			}
		}
		return process(type);
	};
}

export function TStoDecl(program: TS.Program, opts?: Partial<typeof OutputOptionsDefault>): TS.Program {
	const options		= {...OutputOptionsDefault, ...opts};
	const importScope	= program.scope as Scope | undefined;

	// ---- Gathering every top-level declaration, and seeding `reachable` with the explicit exports ----

	type Owner = TS.Stmt | JS.Var<any>;
	class Owners extends Map<string, Owner[]> {
		exported	= false;
		add(name: string, owner: Owner) {
			this.set(name, [...(this.get(name) ?? []), owner]);
			if (this.exported)
				reachable.add(name);
		}
	}

	const owners	= new Owners;
	const reachable = new Set<string>();

	// ---- Shared checking/resolution machinery, needed by the strip helpers below --------------------

	const global	= importScope ? new Scope(importScope) : T.makeGlobal();
	checkBlock(program.body, global);

	// A class whose heritage is a call expression (e.g. `bin.Class(spec)`) can't keep that expression in a
	// `declare class` -- collected here and prepended to `stripped`'s body (below) as `declare const <Name>_base:
	// <computed type>;` ahead of the class, which then just extends the name (mirrors how tsc's own declaration
	// emitter handles this). Names tracked separately so they can be seeded into `reachable`, below -- a
	// synthesized base is always wanted whenever its class is, but nothing else ever references it by name for
	// the normal reachability walk to find on its own.
	const syntheticBases: TS.Stmt[] = [];

	// Cheap, non-recursive scan of every top-level name -- seeded before any stripping starts, so a
	// synthesized base name can't collide with a real declaration the single pass below hasn't reached yet.
	const usedNames = new Set<string>();
	for (let stmt of program.body) {
		if (stmt.type === 'export_decl')
			stmt = stmt.declaration;
		switch (stmt.type) {
			case 'function_decl': case 'class_decl': case 'interface_decl':
			case 'type_alias_decl': case 'enum_decl': case 'namespace_decl':
				usedNames.add(stmt.name);
				break;
			case 'var_decl':
				for (const d of stmt.declarations)
					for (const name of T.bindingNames(d.name))
						usedNames.add(name);
				break;
		}
	}
	const uniqueName = (base: string) => {
		let name = base;
		for (let n = 1; usedNames.has(name); n++)
			name = base + n;
		usedNames.add(name);
		return name;
	};

	// ---- Strip helpers -------------------------------------------------------------------------------

	// `undefined` (rather than an explicit `: any` annotation) keeps unknowable types implicit, as before
	const inferType		= (e: Expr, narrow: boolean): Type | undefined => {
		const t = typeOf(e, global, !narrow);
		return t.type === 'ref' && t.name === 'any' ? undefined : t;
	};

	const stripBindingDefaults = (t: BindingTarget): BindingTarget => {
		if (typeof t === 'string')
			return t;
		if (t.type === 'object_pattern')
			return { ...t, properties: t.properties.map(p => ({ ...p, value: stripBindingDefaults(p.value), default: undefined })) };
		return { ...t, elements: t.elements.map(el => el && ({ ...el, target: stripBindingDefaults(el.target), default: undefined })) };
	};
	
	const stripParam = (p: JS.Param<any>): JS.Param<any> => ({ ...p,
		key:			stripBindingDefaults(p.key),
		typeAnnotation: p.typeAnnotation ?? (p.default && inferType(p.default, false)),
		default:		undefined,
		modifiers:		hasMod(p, 'optional') || !!p.default ? ['optional'] : []
	});

	const PROMISE_TYPES		= new Set(['Promise']);
	const GENERATOR_TYPES	= new Set(['Generator', 'IterableIterator', 'Iterator', 'Iterable']);

	const stripFunctionDecl = (stmt: JS.FunctionDecl<any>): JS.Declaration<any> => {
		const returnType: Type = stmt.returnType ? stmt.returnType as Type : stmt.body ? inferReturn(stmt, stmt.body, global) : T.ANY;
		return JS.FunctionDecl(stmt.name, {
			params:		stmt.params.map(stripParam),
			typeParams:	stmt.typeParams,
			returnType: hasMod(stmt, 'async')		? T.wrapType(returnType, PROMISE_TYPES, 'Promise')
					:	hasMod(stmt, 'generator')	? T.wrapType(returnType, GENERATOR_TYPES, 'Generator')
					:	returnType
		}, undefined, {ambient: true});
	};

	// A single generic type parameter constrained to a union of literals, used directly (unparameterized) as exactly
	// one parameter's type, expands into one non-generic overload per literal member -- each overload's return type
	// collapses toward its own concrete result (e.g. a conditional keyed off the now-literal T narrows to one table
	// entry) instead of the printed signature needing to expose whatever machinery type (often a big lookup table)
	// computed the generic return for every member at once.
	function expandConstrainedGeneric(typeParams: TS.TypeParam[] | undefined, params: JS.Param<any>[], returnType: Type | undefined) {
		const tparam = typeParams?.length === 1 ? typeParams[0] : undefined;
		if (!tparam?.constraint)
			return undefined;
		let target: JS.Param<any> | undefined;
		for (const p of params) {
			if (p.typeAnnotation?.type === 'ref' && !p.typeAnnotation.typeArgs && p.typeAnnotation.name === tparam.name) {
				if (target)
					return undefined;	// ambiguous -- more than one param depends directly on T
				target = p;
			}
		}
		if (!target)
			return undefined;

		const constraint	= T.resolve(global, tparam.constraint);
		const members		= constraint.type === 'union' ? constraint.types : [constraint];
		if (!members.every(m => T.isLiteral(m, 'string') || T.isLiteral(m, 'number')))
			return undefined;

		return members.map(m => ({
			params:		params.map(p => p === target ? { ...p, typeAnnotation: m } : p),
			returnType:	returnType && T.expandRefOnce(global, T.substituteType(returnType, new Map([[tparam.name, m]]))),
		}));
	}

	const stripClassDecl = (stmt: JS.ClassDecl<any>): JS.Declaration<any> => {
		const setKeys	= new Set(stmt.body.map(m => m.type === 'set' && typeof m.key === 'string' ? m.key : undefined).filter(m => m !== undefined));
		const seen		= new Set<string>();
//		const extra:	TS.ClassMember[] = [];

		// `extends bin.Class(spec)` (or any non-identifier heritage) can't survive into a `.d.ts` -- there's no runtime call in an ambient declaration.
		// Hoist its *type* into a synthesized `declare const _base` instead and extend that name instead.
		let superClass = stmt.superClass;
		if (superClass && superClass.type !== 'identifier') {
			const name = uniqueName((stmt.name ?? '_default') + '_base');
			reachable.add(name);
			syntheticBases.push(JS.AmbientVarDecl('const', JS.Var(name, undefined, typeOf(superClass, global))));
			superClass = Identifier(name);
		}

		return {
			...stmt,
			body: (stmt.body as TS.ClassMember[]).flatMap((m): TS.ClassMember[] => {
				switch (m.type) {
					case 'field':
						return [JS.Field(m.key, undefined, m.typeAnnotation ?? (m.value && inferType(m.value, false)) ?? T.ANY)];

					case 'get':
						if (typeof m.key === 'string') {
							if (seen.has(m.key))
								return [];
							seen.add(m.key);
						}
						return [JS.Field(m.key, undefined, m.returnType ?? T.ANY, typeof m.key === 'string' && !setKeys.has(m.key) ? ['readonly'] : undefined)];

					case 'set':
						if (typeof m.key === 'string') {
							if (seen.has(m.key))
								return [];
							seen.add(m.key);
						}
						return [JS.Field(m.key, undefined, m.params[0]?.typeAnnotation ?? T.ANY)];

					case 'method': {
						const extra:	TS.ClassMember[] = [];
						if (m.key === 'constructor') {
							for (const p of m.params) {
								if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected') || hasMod(p, 'readonly'))
									extra.push(JS.Field(typeof p.key === 'string' ? p.key : '?', undefined, p.typeAnnotation, p.modifiers));
							}
							extra.push(JS.Method('method', m.key, {params: m.params.map(stripParam), rest: m.rest, typeParams: m.typeParams}));
							return extra;
							//return [JS.Method('method', m.key, {params: m.params.map(stripParam), rest: m.rest, typeParams: m.typeParams})];
						}
						const params		= m.params.map(stripParam);
						const returnType	= m.returnType ?? (m.body ? inferReturn(m, m.body, global) : undefined);
						const expansions	= expandConstrainedGeneric(m.typeParams, params, returnType);
						if (expansions)
							return expansions.map(o => JS.Method('method', m.key, { params: o.params, rest: m.rest, returnType: o.returnType, typeParams: undefined }, undefined, m.modifiers));

						return [JS.Method('method', m.key, { params, rest: m.rest, returnType, typeParams: m.typeParams }, undefined, m.modifiers)];
					}
				}
				return [];
			})/*.concat(extra)*/ as JS.ClassMember<any>[],
			superClass,
			ambient: true
		};
//		return { ...stmt, body, superClass, ambient: true};
	};

	// Ambient declarations have no initializer to destructure from -- split a destructured declarator into one
	// simple-name declarator per bound name instead, each typed `any`.
	const stripVarDeclarator = (d: JS.Var<any>, narrow: boolean): JS.Var<any>[] => typeof d.name === 'string'
		? [JS.Var(d.name, undefined, (d.typeAnnotation as Type) ?? (d.init && inferType(d.init, narrow)) ?? T.ANY)]
		: T.bindingNames(d.name).map(name => JS.Var(name, undefined, T.ANY));


	// ---- Strip bodies/initializers down to their essentials in one pass, registering owners as we go --

	const stripped = walk(program, (stmt, process) => {
		switch (stmt.type) {
			case 'import':
				return stmt;

			case 'export':
				if (stmt.default?.type === 'identifier')
					reachable.add(stmt.default.name);
				else if (stmt.specifiers && !stmt.source)
					stmt.specifiers.forEach(s => reachable.add(s.local));
				return process(stmt);

			case 'export_decl':
				try {
					owners.exported = true;
					return process(stmt);
				} finally {
					owners.exported = false;
				}
			case 'function_decl': {
				const s = stripFunctionDecl(stmt);
				owners.add(stmt.name, s);
				return s;
			}
			case 'class_decl': {
				const s = stripClassDecl(stmt);
				owners.add(stmt.name, s);
				return s;
			}
			case 'interface_decl':
			case 'type_alias_decl':
			case 'enum_decl':
			case 'namespace_decl':
			case 'module_decl':
				owners.add(stmt.name, stmt);
				return process(stmt);	// namespace/module bodies can nest further declarations -- recurse so those get stripped too

			case 'export_assignment':
				// `export = Foo;` -- not a declaration itself, just marks whatever it names as always needed.
				reachable.add(stmt.expr.split('.')[0]);
				return stmt;

			case 'var_decl':
				for (const d of stmt.declarations) {
					for (const name of T.bindingNames(d.name))
						owners.add(name, d);
				}
				return stmt;
			default:
				return undefined;
		}
	})!;

	const collectDeclRefs = (owner: TS.Stmt|Expr|Type, refs: Set<string>) => walk(owner,
		undefined,
		(e, process) => {
			if (e.type === 'identifier')
				refs.add(e.name.split('.')[0]);
			return process(e);
		},
		(t, process) =>{
			if (t.type === 'ref')
				refs.add(t.name.split('.')[0]);
			return process(t);
		}
	);

	const worklist	= [...reachable];
	while (worklist.length) {
		const refs = new Set<string>();
		for (const owner of owners.get(worklist.pop()!) ?? []) {
			if ('type' in owner) {
				collectDeclRefs(owner, refs);
			} else {
				if (owner.init)
					collectDeclRefs(owner.init, refs);
				if (owner.typeAnnotation)
					collectDeclRefs(owner.typeAnnotation as Type, refs);
			}
		}
		for (const ref of refs) {
			if (!reachable.has(ref)) {
				reachable.add(ref);
				worklist.push(ref);
			}
		}
	}

	// ---- Final rebuild: keep only what's reachable, from the already-stripped tree above -------------

	stripped.body.splice(stripped.body.findLastIndex(i => i.type === 'import') + 1, 0, ...syntheticBases);

	return walk(stripped,
		(stmt, process) => {
			switch (stmt.type) {
				case 'import':
					if (stmt.specifiers) {
						const spec = stmt.specifiers!.filter(s => reachable.has(s.local));
						if (!spec.length)
							return undefined;
						return { ...stmt, specifiers: spec};

					} else if (stmt.namespace) {
						if (!reachable.has(stmt.namespace))
							return undefined;
					}
					return stmt;

				case 'export_decl': {
					const r = process(stmt);
					return r.declaration ? r : undefined;
				}

				case 'export':
					if (stmt.default) {
						switch (stmt.default.type) {
							case 'identifier':
								return stmt;
							case 'function_decl':
							case 'class_decl':
								// already stripped in the earlier pass -- still needs `process` to run its types through `onType`
								return process(stmt);
							case 'function':
								if (stmt.default.name)
									return process({ ...stmt, default: stripFunctionDecl(JS.FunctionDecl(stmt.default.name, stmt.default))});
								//fallthrough
							default:
								// Anonymous default export -- ambient declarations can't have an inline value, so synthesize a name, the same trick `tsc` uses.
								return { type: 'export', default: Identifier('_default') };
						}
					}
					return stmt;

				case 'function_decl':
				case 'class_decl':
				case 'interface_decl':
				case 'type_alias_decl':
				case 'enum_decl':
				case 'namespace_decl':
				case 'module_decl':
					return reachable.has(stmt.name) ? process(stmt) : undefined;

				case 'export_assignment':
					return stmt;

				case 'var_decl': {
					const declarations = stmt.declarations.filter(d => T.bindingNames(d.name).some(n => reachable.has(n)));
					return declarations.length
						? process({ ...stmt,
							ambient:		true,
							declarations:	declarations.flatMap(d => stripVarDeclarator(d, stmt.kind === 'const'))
						})
						: undefined;
				}

				default:
					return undefined;
			}
		},
		undefined,
		resolveTypes(global, importScope)
	)!;
}

