import assert from 'assert';
import * as TS from '../src/examples/TS/ts-parser';
import { BuildVSDG, Optimize, applyGlobalCodeMotion, Output } from '../src/examples/TS/vsdg';
import { Output as CodeOutput } from '../src/examples/TS/tocode';

// Regression suite for vsdg.ts's BuildVSDG -> applyGlobalCodeMotion -> Output pipeline: builds
// the VSDG for a program, schedules it, and reconstructs source from the result, then checks the
// EXACT printed output against a known-correct expected string. Each test below traces back to a
// real bug found (and fixed) while getting this pipeline working; the comment on each names the bug
// so a future regression here points straight at what broke.
//
// Calls named `pureXxx` are treated as pure (no state threading) by BuildVSDG's temporary
// naming-convention placeholder for real purity analysis (not implemented yet) -- see the `pure`
// check in BuildVSDG's 'call' case. Every other call name is treated as effectful.

const printer = new CodeOutput();

// Every (name, src, expected) triple `check` is given, in call order -- populated as a side effect
// of running `main` below, purely so a SEPARATE harness (e.g. one verifying Output's no-blocks path
// against the same sources) can reuse them without duplicating 36 test cases by hand.
export const testCases: { name: string; src: string; expected: string }[] = [];

function compile(src: string): string {
	const prog		= TS.parse(src);
	const graph		= BuildVSDG(prog.body);
	Optimize(graph);
	const { blockIds, blockControl, getLoopDepth } = applyGlobalCodeMotion(graph);
	const stmts = new Output(graph, blockIds, blockControl, getLoopDepth).buildProgram();
	return printer.toCode(stmts as any).trim();
}

function indent(s: string) {
	return s.split('\n').map(line => '    ' + line).join('\n');
}

// Expected-output template literals are written indented (with tabs, this file's own convention) to
// match their surrounding source code, not tocode's own indentation convention (fixed 2-space units)
// -- strips the common leading whitespace off every line (like an editor's "dedent" would), then
// converts each remaining leading tab (nested-block indentation within the literal) into tocode's own
// 2-space unit, so the literal's own formatting is irrelevant to the comparison.
function dedent(s: string): string {
	const lines		= s.replace(/^\n/, '').replace(/\n[ \t]*$/, '').split('\n');
	const indents	= lines.filter(l => l.trim().length > 0).map(l => l.match(/^[ \t]*/)![0].length);
	const min		= indents.length ? Math.min(...indents) : 0;
	return lines.map(l => {
		const rest			= l.slice(min);
		const leadingTabs	= rest.match(/^\t*/)![0].length;
		return '  '.repeat(leadingTabs) + rest.slice(leadingTabs);
	}).join('\n');
}

export async function main() {
	let failures = 0;
	const check = (name: string, src: string, expected: string) => {
		testCases.push({ name, src, expected });
		let actual: string;
		try {
			actual = compile(src);
		} catch (e) {
			++failures;
			console.error(`FAIL - ${name}: threw ${e instanceof Error ? e.stack ?? e.message : e}`);
			return;
		}
		const wantExpected = dedent(expected);
		try {
			assert.strictEqual(actual, wantExpected);
			console.log(`ok - ${name}`);
		} catch {
			++failures;
			console.error(`FAIL - ${name}:\n  expected:\n${indent(wantExpected)}\n  actual:\n${indent(actual)}`);
		}
	};

	// A nested call's argument was, before the double-process fix, walked twice by the expression
	// hook (once via an explicit `process(s)` inside the case, once more via an unconditional
	// trailing `process(s)` after the switch) -- so `h()` here would have compiled to two separate
	// effect nodes, i.e. actually calling `h` twice. Also exercises call-inlining: `h`'s only value
	// consumer (`g`'s argument) is also its own direct state-chain successor, so it's safe to inline
	// with no temp at all.
	check('nested call: no double-processing, inlines cleanly', `
		g(h());
	`, `
		g(h());
	`);

	// `if`'s statement handler used to call `process(s.consequent)` instead of `recurse(s.consequent)`
	// -- `process` only walks a node's own children, never the node it's given, so a block consequent
	// never got its OWN scope-wrapping (`var_decl`'s binding leaked into the branch scope instead of
	// staying local to the block), and crashed reconciling the merge afterward. Also exercises:
	// declared-locals materialization (`let a = 1;` was never emitted at all, before that fix), the
	// per-variable named-gamma value merge (never had a codegen case before -- always threw), and
	// dead-initializer elimination (`x`'s declared value of 1 is unconditionally overwritten by both
	// branches before anything reads it, so its own declaration drops -- see emitNamedSlot's own
	// comment: nothing ever reads `x`/`a` by name once their value's fully inlined, so an unassigned
	// `let x;`/`let a;` has no purpose and prints nothing at all). `a`'s own declared value inlines
	// too, by the same single-consumer rule as any other local: its only reader is the merge's own
	// condition. The merge itself (`x`) has exactly one real reader too (`h(x)`) -- named gammas are
	// just as inlinable as an ordinary reassignment (isInlinableSlot), so it inlines straight into
	// `h(...)` instead of needing its own `x = ...;` statement.
	check('if: merged value, both branches always reassign -> dead initializer dropped', `
		let x = 1;
		let a = 1;
		if (a) {
			x = 2;
		} else {
			x = 3;
		}
		h(x);
	`, `
		h(1 ? 2 : 3);
	`);

	// A loop's own state-mu was, before the port-consistency and scheduling fixes, prone to two
	// distinct bugs: `connectValue`'s reversed argument order silently corrupted the loop body's own
	// reassignment (`i = i + 1` became `i = i`, with the real `i + 1` computation orphaned), and
	// `localTopologicalSort` followed the mu's feedback edge as an ordinary dependency (a genuine
	// back-edge -- that's what makes it a loop), causing a stack overflow. Also exercises: loop
	// rotation (`while (cond) { body }` is structurally impossible when `cond` depends on values only
	// available once already inside the loop; becomes `while (true) { compute cond; if (!cond) break; body }`),
	// and that the loop test inlines with no temp (its only real reader is the loop-exit check itself
	// -- every named theta's own condition port is a vestigial edge, present in the graph for GCM but
	// never actually read by codegen).
	check('while: reassignment-only body, loop test inlines with no temp', `
		let n = 10;
		let i = 0;
		while (i < n) {
			i = i + 1;
		}
		h(i);
	`, `
		let n = 10;
		let i = 0;
		while (true) {
			if (!(i < n)) {
				break;
			}
			i = i + 1;
		}
		h(i);
	`);

	// A call reading a loop-carried variable, immediately followed by a reassignment of that SAME
	// variable, is the core case the whole reassignment-ordering mechanism exists for: `g` and the
	// reassignment are graph SIBLINGS (both independently read the mu's current value, with no edge
	// between them), so nothing but explicit ordering keeps `g(i)` from silently printing after
	// `i = i + 1` and reading the wrong (post-increment) value.
	check('while: call reading the loop variable stays ordered before its reassignment', `
		let n = 10;
		let i = 0;
		while (i < n) {
			g(i);
			i = i + 1;
		}
		h(i);
	`, `
		let n = 10;
		let i = 0;
		while (true) {
			if (!(i < n)) {
				break;
			}
			g(i);
			i = i + 1;
		}
		h(i);
	`);

	// `g()` inlines directly into `y`'s own declaration (its sole consumer is `y`'s var_decl, whose
	// own mutation-marker is `g`'s direct state successor -- nothing can run between them, so this is
	// exactly as safe as inlining a call into another call). `y` ITSELF still needs a real declared
	// name, though: it's genuinely reused (`y + y`), and unlike a pure value, recomputing a call isn't
	// free -- inlining `g()` twice would call it twice.
	check('call result assigned to a variable that is reused: call inlines, the variable does not', `
		let y = g();
		h(y + y);
	`, `
		let y = g();
		h(y + y);
	`);

	// `a`, `b`, and `a + b` are each read exactly once, so none of them need a printed value -- `a`
	// and `b` stay declared bare (their own single reader, the `+`, inlines each initializer
	// directly), and the sum inlines straight into `x`'s own declaration. `x` itself is genuinely
	// reused (twice, in `x + x`) so it keeps a real declared name and value, not a synthetic temp.
	check('shared subexpression: only genuine reuse (x) gets a name, not every intermediate value', `
		let a = 1;
		let b = 2;
		let x = a + b;
		h(x + x);
	`, `
		let x = 1 + 2;
		h(x + x);
	`);

	// Exercises trueEntry/falseEntry (finding the FIRST block of a branch containing multiple
	// effects, not just the last one `control.inputs[2]`/`[3]` directly reference) and the
	// `successorBlock` fix that prefers a gamma/mu match over a plain effect fallback (`parent.end`
	// has simultaneous port-0 consumers: the true branch's first effect AND the eventual merge-gamma;
	// only the gamma is really "what comes next in sequence"). `g(2)`/`h(3)` print bare, with no
	// temp: being a branch's own state-chain tail (feeding the merge-gamma's trueTail/falseTail ports)
	// is structural bookkeeping, not a real value read -- neither call's result is used by anything.
	//
	// `a` itself is never reassigned, so its own declared value (1) is a provably-constant literal --
	// isInlinableVarDecl's own literal exemption (see its comment) means it's cheap to duplicate at
	// EVERY reader, not just a single one, so `a`'s own declaration drops entirely and both `if (a)`
	// and `k(a)` read the literal directly.
	check('if: multi-statement branches with real effects reconstruct as a real if/else', `
		let a = 1;
		if (a) {
			f(1);
			g(2);
		} else {
			h(3);
		}
		k(a);
	`, `
		if (1) {
			f(1);
			g(2);
		} else {
			h(3);
		}
		k(1);
	`);

	// One branch has only a pure reassignment (no real effect at all -- must NOT be wrapped in a
	// spurious empty `if (a) {} else { ... }`, which threading every reassignment through the state
	// chain for ordering purposes risked doing), the other has a real call. `hasRealEffect` walks
	// back through mutation markers specifically to tell "a branch had a real effect" apart from
	// "a branch only reassigned something", which decides whether a structural gamma is needed at all.
	// The `if/else` itself still has to exist (to conditionally run `f(9)`), but both branch values
	// (2 and 3) are single-consumer pure literals, so they inline straight into the merge ternary --
	// leaving the true branch genuinely empty (an unavoidable byproduct here, not a "spurious" wrapper:
	// something still has to conditionally guard `f(9)`). The merge itself is ALSO single-consumer
	// (only `h(x)` reads it), so it inlines too, straight into `h(...)`. `a`'s own declared value (1)
	// is never reassigned either, so it's ALSO a duplicable literal (isInlinableVarDecl's own literal
	// exemption) -- its declaration drops too, and both `if (a)` and the merge's own condition read
	// the literal directly.
	check('if: one branch pure, one branch effectful -- no spurious empty branch', `
		let x = 1;
		let a = 1;
		if (a) {
			x = 2;
		} else {
			f(9);
			x = 3;
		}
		h(x);
	`, `
		if (1) {
			
		} else {
			f(9);
		}
		h(1 ? 2 : 3);
	`);

	// A reassignment sandwiched between two effects in the SAME branch (`x = 2; f(x); x = 3;`):
	// ordering must hold within a branch too, not just across one. `x = 2;` itself inlines away
	// (its only reader is the very next statement, in the same block, so `x` never needs to
	// observably hold 2 -- f(x) becomes f(2), same as an anonymous single-use temp would). `x`'s
	// declared initial value (1) and the branch's final value (3) are each single-consumer pure
	// values too -- both inline straight into the merge ternary, which is what actually needs them
	// (the `if` has no `else`, so the false path genuinely falls through to x's original value of 1).
	// The merge itself has exactly one real reader (`h(x)`), so it inlines too.
	// `a`'s own declared value (1) is never reassigned, so it's a duplicable literal too
	// (isInlinableVarDecl's own literal exemption) -- its declaration drops, `if (a)`/the merge's
	// own condition both read the literal directly.
	check('if: reassignment between two effects in the same branch stays correctly ordered', `
		let x = 1;
		let a = 1;
		if (a) {
			x = 2;
			f(x);
			x = 3;
		}
		h(x);
	`, `
		if (1) {
			f(2);
		}
		h(1 ? 3 : 1);
	`);

	// An `if` nested inside a `while`: the reassignment ordering fix's first attempt (reverted --
	// see threadMutation's own comment) connected a reassignment directly to the specific effect
	// that read the old value, which also inherited that effect's SCHEDULING DEPTH, dragging the
	// unconditional `i = i + 1` inside the conditional `g` happened to be nested in -- turning this
	// into an infinite loop whenever `i` was falsy. This is that exact case, kept as a permanent
	// regression guard.
	check('while: if nested in loop body does not drag the reassignment inside it', `
		let n = 10;
		let i = 0;
		while (i < n) {
			if (i) {
				g(i);
			}
			i = i + 1;
		}
		h(i);
	`, `
		let n = 10;
		let i = 0;
		while (true) {
			if (!(i < n)) {
				break;
			}
			if (i) {
				g(i);
			}
			i = i + 1;
		}
		h(i);
	`);

	// A PURE call (`type: 'call'`, not `'effect'` -- see BuildVSDG's `pure` check) is otherwise just
	// an ordinary value node: single-use inlines with no temp, exactly like pure arithmetic.
	check('pure call, single use: inlines with no temp', `
		h(pureFoo(1));
	`, `
		h(pureFoo(1));
	`);

	// A pure call's result, genuinely reused, still needs a real name -- recomputing a call (even a
	// pure one) on every use isn't free the way recomputing a literal is, and a var_decl's own
	// declared name is exactly what expresses "compute this once".
	check('pure call, result used twice: gets a real name', `
		let x = pureFoo(1);
		h(x + x);
	`, `
		let x = pureFoo(1);
		h(x + x);
	`);

	// A pure call feeding an effectful one: `x`'s declaration must still land before `g(x)`/`h(x)`,
	// same as any other declaration order guarantee, regardless of the initializer's purity.
	check('pure call mixed with effectful calls stays correctly ordered', `
		let x = pureFoo(1);
		g(x);
		h(x);
	`, `
		let x = pureFoo(1);
		g(x);
		h(x);
	`);

	// An initializer with a real side effect (a call) must NEVER be silently dropped, even when its
	// resulting VALUE is dead (unconditionally overwritten before any read) -- only a PROVABLY pure
	// initializer (isPureSubgraph) is eligible for the dead-initializer VALUE simplification. But the
	// call itself and x's own binding to its result are two separate things: since x's value is dead,
	// nothing needs to receive f()'s result at all, so the call is materialized on its own (still
	// running at exactly its declared position) while x's declaration goes bare, same as a pure dead
	// initializer would -- `let x = f();` splits into a standalone `f();` plus `let x;`. The merge
	// itself has one real reader (`h(x)`), so it inlines straight into `h(...)` too.
	check('effectful initializer runs for its side effect, even though its assigned value is dead', `
		let x = f();
		let a = 1;
		if (a) {
			x = 2;
		} else {
			x = 3;
		}
		h(x);
	`, `
		f();
		h(1 ? 2 : 3);
	`);

	// A declared-but-uninitialized local, later assigned via a plain `=`: exercises var_decl's own
	// "declare without an initializer" path (distinct from the dead-initializer-elimination path
	// above, which starts from a REAL initializer and decides to drop it).
	// `x = 5;` has a single, same-block reader (h(x)) -- it inlines away just like the intermediate
	// reassignment case above, leaving `x` declared but never observed to hold 5.
	check('declared without an initializer, assigned later', `
		let x;
		x = 5;
		h(x);
	`, `
		let x;
		h(5);
	`);

	// Prefix ++/-- reassigns through the SAME rebindVar/mutation-ordering path as `binary` ASSIGN_OPS
	// (a separate call site in BuildVSDG) -- a regression here would mean that path alone regressed.
	check('prefix increment reassigns and orders correctly against a call', `
		let i = 0;
		g(i);
		++i;
		h(i);
	`, `
		let i = 0;
		g(i);
		++i;
		h(i);
	`);

	// `break`/`continue` didn't exist as statement types at all before this batch -- the `if` handler
	// now treats a branch that exited (break/continue/return) the same way it treats a real effect:
	// it forces a structural gamma (so the break's own marker survives to be printed), and whatever
	// textually follows the if is only reachable via the non-exited branch. A simple, unconditional
	// break needs none of that machinery on its own, but exercises the marker printing itself.
	check('while: unconditional break inside a nested if', `
		let i = 0;
		while (i < 10) {
			if (i === 3) {
				break;
			}
			i = i + 1;
		}
		h(i);
	`, `
		let i = 0;
		while (true) {
			if (!(i < 10)) {
				break;
			}
			if (i === 3) {
				break;
			}
			i = i + 1;
		}
		h(i);
	`);

	// The bug this guards against: `i = i + 1;` sits on the branch that CONTINUES, before the
	// `continue;`. Per-variable reconciliation normally supersedes a branch's own reassignment,
	// deferring it to inline into a merge gamma printed AFTER the if -- but that merge point is
	// unreachable from an exited path (the continue already left). Without forcedPrint, the
	// increment silently never happens and `i` gets stuck forever (an actual infinite loop was
	// observed before this fix). The exited branch's own reassignment must stay a real, in-place
	// statement instead of being merged away.
	check('while: reassignment before continue is not deferred into an unreachable merge', `
		let n = 0;
		let i = 0;
		while (i < 10) {
			if (i === 7) {
				break;
			}
			if (i % 2 === 0) {
				i = i + 1;
				continue;
			}
			n = n + i;
			i = i + 1;
		}
		h(n);
	`, `
		let n = 0;
		let i = 0;
		while (true) {
			if (!(i < 10)) {
				break;
			}
			if (i === 7) {
				break;
			}
			var t0 = i + 1;
			if ((i % 2) === 0) {
				i = t0;
				continue;
			}
			n = n + i;
			i = t0;
		}
		h(n);
	`);

	// `exited` propagates through nested if/else (only "fully exited" when BOTH branches did): the
	// outer if's true branch breaks unconditionally; its false branch is itself an if where the
	// true side breaks and the false side falls through (g(3)) -- so the outer false branch does
	// NOT fully exit, and `i = i + 1;` after the whole nested structure stays correctly reachable
	// only via the g(3) path, exactly as real JS break semantics would have it.
	check('while: exited-ness propagates correctly through nested if/else', `
		let i = 0;
		while (i < 10) {
			if (i === 3) {
				g(1);
				break;
			} else {
				if (i === 8) {
					g(2);
					break;
				} else {
					g(3);
				}
			}
			i = i + 1;
		}
		h(i);
	`, `
		let i = 0;
		while (true) {
			if (!(i < 10)) {
				break;
			}
			if (i === 3) {
				g(1);
				break;
			} else {
				if (i === 8) {
					g(2);
					break;
				} else {
					g(3);
				}
			}
			i = i + 1;
		}
		h(i);
	`);

	// The bug this guards against: a reassignment right before a `break` INSIDE a nested `if` (so the
	// if's own two branches disagree on whether they exited) used to have its value silently dropped
	// from the merge -- correct for a plain `if` (nothing past it is reachable except via the live
	// branch), but wrong once the enclosing construct is a LOOP: `break` exits the loop itself, and
	// code after the loop is reachable via EVERY break point, not just the one where nothing broke.
	// Before the fix, `return total;` here always saw total's PRE-loop value (0), never either
	// branch's own reassignment.
	check('while: a reassignment right before break, nested in an if, survives to after the loop', `
		function f(c) {
			let total = 0;
			while (true) {
				if (c) {
					total = 10;
					break;
				}
				total = 20;
				break;
			}
			return total;
		}
	`, `
		function f(c) {
			let total = 0;
			while (true) {
				if (c) {
					total = 10;
					break;
				}
				total = 20;
				break;
			}
			return total;
		}
	`);

	// The bug this guards against: a NAMED gamma (a per-variable merge, e.g. an `else if` chain's
	// inner merge) unconditionally resolved to `Identifier(name)`, same as the `binary`-reassignment
	// bug fixed earlier -- correct only if something actually printed `name = ...;` for it. A purely
	// pure, no-real-effect `else if` chain builds a NAMED gamma with no state anchor of its own, so
	// its scheduled block was never visited by blocksToAST's traversal at all: it silently never
	// printed while the outer merge still read its name as if it had been (`x` read back as
	// `undefined`). isInlinableSlot now covers 'gamma' the same way it already covers 'binary': a
	// single-consumer named gamma inlines directly into whatever reads it, sidestepping the
	// unreachable-block problem entirely instead of trying to fix block reachability itself.
	check('if: else-if chain collapses through nested named-gamma merges', `
		let x = 0;
		let a = 1;
		let b = 2;
		if (a) {
			x = 10;
		} else if (b) {
			x = 20;
		} else {
			x = 30;
		}
		h(x);
	`, `
		h(1 ? 10 : 2 ? 20 : 30);
	`);

	// `switch` didn't exist as a statement type at all before this batch (and had a prerequisite:
	// break/continue support, above). It's lowered into an ordinary `if` cascade with a synthetic
	// `__hit` fallthrough flag, fed back through `recurse` -- reusing the if-handler's own
	// exit-tracking/gamma machinery entirely as-is. Building this exposed three genuinely
	// pre-existing/newly-introduced bugs, all fixed alongside it:
	// (1) `walker.ts`'s `isType` guard mis-routed ANY bare expression-level `literal` node (e.g. a
	// `while (true)` test) to the no-op type-walker, since a type-level literal type and an
	// expression-level literal value are IDENTICAL shapes with no structural way to tell them
	// apart -- fixed by letting `recurse` take an explicit `'expression'` hint (a real, general
	// bug: even a hand-parsed `if (true) {...}` hit it, nothing to do with switch specifically);
	// (2) the discriminant's own wrapper node was built by hand but never threaded into the state
	// chain via `rebindVar`, so `let __disc = ...;` never printed even though every case read it;
	// (3) an initial `while (true) { ...; break; }` wrapping (chosen for break's syntactic
	// validity) was itself a real loop, so a `continue` inside a case -- which real JS routes PAST
	// a switch to the nearest enclosing loop -- got wrongly caught by the wrapper instead, an
	// infinite loop whenever the switch's own discriminant stayed constant. Fixed by giving switch
	// its own minimal `break_scope` graph anchor (no mu/theta, no continue target of its own),
	// reconstructed as an always-matching `switch (0) { case 0: ... }` purely for break's
	// syntactic target -- real JS's own `continue` already skips past a switch correctly.
	//
	// `x`'s own declared value (1) is never reassigned, so it's a duplicable literal
	// (isInlinableVarDecl's own literal exemption) -- its declaration drops, and both the
	// discriminant's own initializer and `h(x)` read the literal directly.
	check('switch: break exits, default matches when nothing else does', `
		let x = 1;
		switch (x) {
			case 1:
				g(1);
				break;
			case 2:
				g(2);
				break;
			default:
				g(99);
		}
		h(x);
	`, `
		let __disc_var4 = 1;
		switch (__disc_var4) {
			case 1:
				g(1);
				break;
			case 2:
				g(2);
				break;
			default:
				g(99);
		}
		h(1);
	`);

	// A case with no `break` falls straight into the next one (the classic switch fallthrough
	// footgun) -- once `__hit` is set by case 1 matching, every later case's own test becomes
	// irrelevant, so cases 2 and 3 both run (case 3's own `break` then stops it before case 4).
	// `x`'s own declared value (2) is never reassigned, so (isInlinableVarDecl's own literal
	// exemption) it's a duplicable literal -- its declaration drops in favor of both real readers.
	check('switch: fallthrough runs every case until the next break', `
		let x = 2;
		switch (x) {
			case 1:
				g(1);
			case 2:
				g(2);
			case 3:
				g(3);
				break;
			case 4:
				g(4);
		}
		h(x);
	`, `
		let __disc_var4 = 2;
		switch (__disc_var4) {
			case 1:
				g(1);
			case 2:
				g(2);
			case 3:
				g(3);
				break;
			case 4:
				g(4);
		}
		h(2);
	`);

	// `default` written FIRST must still only match when no other case does -- real switch
	// semantics are position-independent (default only wins when nothing else matches, wherever
	// it's written), unlike a naive "positional hit cascade" would give.
	//
	// `x`'s own value (5) is a provably dead, single-use initializer, so it inlines into __disc's
	// own declaration same as any other local -- and __disc itself is now ALSO correctly seen as
	// inlinable (isPureSubgraph's own fix this session: threadMutation's scheduling-only marker edge
	// was wrongly making every declaration that goes through rebindVar look "impure", including
	// __disc's own). With nothing ever reading __disc by name (its value, 5, inlines directly at its
	// one real use, the switch's own discriminant), its own declaration has no purpose and drops
	// entirely (see emitNamedSlot's own comment on dropping an unassigned, unreferenced `let`).
	check('switch: default matches by exclusion regardless of its position', `
		let x = 5;
		switch (x) {
			default:
				g(0);
				break;
			case 1:
				g(1);
				break;
		}
	`, `
		switch (5) {
			default:
				g(0);
				break;
			case 1:
				g(1);
				break;
		}
	`);

	// The bug break_scope exists to fix: `continue` inside a switch case, itself nested in a real
	// enclosing loop, must skip PAST the switch to the outer loop (real JS semantics -- a switch is
	// not a continue target). With the earlier `while (true)` wrapping, this infinite-looped (the
	// synthetic wrapper caught the continue instead of the real outer while). Since break_scope
	// reconstructs as a plain `switch`, not a loop, real JS's own continue semantics get this right
	// with no special handling needed at all -- the switch(0){} wrapper is simply not a valid
	// continue target, exactly like a real switch statement.
	//
	// __match0/__hit both print (with real initializers): `continue` is a real jump elsewhere, not
	// "nothing happens" the way a bare `break` is, so neither case here is switchIsNoOp-eligible --
	// and each is genuinely read twice (once by its own case's match test, once more by default's
	// own "did nothing else match" exclusion test), so needsTemp correctly keeps them named.
	check('switch: continue inside a case skips past the switch to the outer loop', `
		let i = 0;
		while (i < 3) {
			switch (i) {
				case 1:
					i = i + 1;
					continue;
				default:
					h(i);
			}
			i = i + 1;
		}
	`, `
		let i = 0;
		while (true) {
			if (!(i < 3)) {
				break;
			}
			let __disc_var8 = i;
			let __match0_var8 = __disc_var8 === 1;
			let __hit_var8 = false;
			var t0 = i + 1;
			switch (__disc_var8) {
				case 1:
					i = t0;
					continue;
				default:
					h(i);
			}
			i = t0;
		}
	`);

	// A variable reassigned in MULTIPLE cases, each ending in `break` -- the case this session's own
	// exit-value-merging bug hid in: `break` only exits the switch's own break_scope, not the whole
	// function, so code after the switch is reachable via EVERY case's own break point, not just the
	// path where nothing matched. Before that fix, each case's own reassignment was silently dropped
	// from the merge (kept only via forcedPrint, in place), so `return total;` after the switch never
	// actually observed any of case 1/2's own values -- always the pre-switch default.
	//
	// forcedPrint used to be unconditional for a break-exited branch's own reassignment -- correct
	// for the case above, but needlessly conservative for a one-shot merge like this one (no
	// enclosing loop): a pure value has no "next iteration" that needs a real, mutated variable to
	// carry it forward, so it's just as safe to fold straight into the merge, exactly like default's
	// `-1` already did. forcedPrint is now conditional on the reassignment being loop-carried
	// (isLoopCarried) -- so case 1/2's own `total = ...;` folds directly into the return ternary too.
	// switch's own internal bookkeeping (__hit_var8's `hit = true;`) is unaffected by this relaxation
	// -- it's tagged switchInternal specifically so it keeps resolving by name regardless, which is
	// what keeps t0/t1/t2 computing the same independent, one-shot match flags as before (a real bug
	// this session: relaxing forcedPrint without that tag let __hit_var8's value get folded into a
	// genuine "did an earlier case already match" merge, which is wrong for these pre-switch flags).
	// With every case's own value elided, each case's body reduces to a bare `break;` -- and once
	// EVERY case (including default) is in that shape, the whole dispatch is observably a no-op
	// (every entry point does nothing and falls out the same way) and gets dropped entirely, not
	// just each case's own value -- see emitControlNode's own switchIsNoOp check.
	//
	// t0/t1/t2 themselves are now also single-use (their only real reader, once the state gamma
	// bypassed by switchCases and __hit's own collapsing merge are correctly excluded from counting
	// -- both real graph edges, neither ever actually read at print time -- is `total`'s own merge,
	// which reads them as ITS condition), so they inline straight into the return ternary too,
	// instead of needing their own `var tN = ...;` statement.
	//
	// __hit_var8's own gammaValue merge (per case) still collapses to a bare `Identifier('__hit_var8')`
	// -- isInlinableVarDecl's own literal exemption (letting a genuinely-read literal declaration
	// drop when nothing ELSE needs it named) would otherwise make the ORIGINAL declaration resolve
	// straight to the literal `false` instead, breaking the "both branches are the exact same
	// expression" match buildExpr's "cond ? x : x -> x" shortcut needs -- resolveNode's own
	// isInlinableVarDecl check additionally requires !hasForcedSibling, so whenever a switchInternal
	// (or ordinary forced) sibling guarantees SOME other read resolves by name, this declaration
	// stays consistent with it instead of inlining its own value.
	check('switch: a variable reassigned in multiple break-ending cases survives to after the switch', `
		function f(x) {
			let total = 0;
			switch (x) {
				case 1:
					total = 10;
					break;
				case 2:
					total = 20;
					break;
				default:
					total = -1;
			}
			return total;
		}
	`, `
		function f(x) {
			let __disc_var8 = x;
			let __match0_var8 = __disc_var8 === 1;
			let __match1_var8 = __disc_var8 === 2;
			let __hit_var8 = false;
			return (__hit_var8 || !(__match0_var8 || __match1_var8)) ? -1 : (__hit_var8 || __match1_var8) ? 20 : (__hit_var8 || __match0_var8) ? 10 : 0;
		}
	`);

	// The regression this session's own switchInternal fix guards: __hit's own reassignment used to
	// be indistinguishable from an ordinary user reassignment once forcedPrint became conditional
	// (see the previous test's own comment) -- letting its merged value fold into a real "already
	// matched" ternary broke case dispatch entirely (every input returned the SAME, wrong result).
	// This is deliberately the minimal repro: two break-ending cases with nothing but a pure
	// reassignment in each, verified to still dispatch correctly to the RIGHT case's own value.
	// With no default at all, both cases end up effectively empty too, so the switch itself elides
	// entirely -- exactly the same switchIsNoOp path as the previous test's own. __match0/__match1
	// have only one real reader each (their own case's own test -- no default means no "did nothing
	// else match" exclusion test to read them a second time), so they inline directly into t0/t1's
	// own computation (an isPureSubgraph fix: threadMutation's own scheduling-only marker edge was
	// wrongly making every rebindVar'd declaration look impure). t0/t1 themselves are then also
	// single-use once more (total's own merge is their only real reader, same reasoning as the
	// previous test's own), so they inline straight into the return ternary too. __hit_var8's own
	// per-case merge still collapses to the bare name too, same hasForcedSibling-gated reasoning as
	// the previous test's own comment.
	check('switch: internal hit/match bookkeeping stays independent when case values are elided', `
		function f(x) {
			let total = 0;
			switch (x) {
				case 1:
					total = 10;
					break;
				case 2:
					total = 20;
					break;
			}
			return total;
		}
	`, `
		function f(x) {
			let __disc_var8 = x;
			let __hit_var8 = false;
			return (__hit_var8 || (__disc_var8 === 2)) ? 20 : (__hit_var8 || (__disc_var8 === 1)) ? 10 : 0;
		}
	`);

	// `do_while` didn't exist as a statement type at all before this batch. Unlike `while`, it
	// needs no loop-rotation trick at all: the body already runs before the test in do-while's own
	// native semantics (the loop-carried mu's INITIAL value is what the body sees on its first
	// pass), so `do { body } while (test);` reconstructs directly -- reusing the exact same
	// mu/theta machinery `while` already has (factored into a shared `buildLoop` helper), just
	// walking body before test instead of after.
	check('do_while: body runs once unconditionally before the first test', `
		let i = 0;
		do {
			g(i);
			i = i + 1;
		} while (i < 3);
		h(i);
	`, `
		let i = 0;
		do {
			g(i);
			i = i + 1;
		} while (i < 3);
		h(i);
	`);

	// The bug this guards against: a REAL, previously-latent GCM scheduling gap, not a do-while-
	// specific workaround. `scheduleLate` never excluded a STATE theta's own condition edge (port
	// 1) from ordinary "must be ready by this consumer's block" treatment, the way it already
	// excluded a mu's feedback edge and a named gamma's value ports -- the theta's own block
	// represents "after the loop has exited" (logically outside it), but the condition it reads is
	// physically computed INSIDE the loop, every iteration. A `while` loop's test is always read
	// BEFORE the body, so it can never depend on a body-computed reassignment directly -- only
	// `do...while` can (its test runs AFTER the body), which is why this never surfaced until now.
	// Left unfixed, `i = i + 1;` was scheduled one loop-nesting level too shallow (tied with, and
	// losing a depth tie-break to, the loop header itself), printing AFTER `if (i === 2) { break; }`
	// instead of before it -- silently reordering two statements relative to their real source order.
	check('do_while: a reassignment the test reads directly stays correctly ordered before a later break', `
		let i = 0;
		do {
			i = i + 1;
			if (i === 2) {
				break;
			}
		} while (i < 5);
		h(i);
	`, `
		let i = 0;
		do {
			i = i + 1;
			if (i === 2) {
				break;
			}
		} while (i < 5);
		h(i);
	`);

	// `for` didn't exist as a statement type at all before this batch. Desugars to `while (test) {
	// body; update; }` (init runs once, before the loop), reusing buildLoop's existing while-shaped
	// mu/theta machinery entirely as-is -- no new graph machinery needed for the ordinary,
	// no-continue case.
	check('for: init/test/update reconstruct as an ordinary while loop', `
		for (let i = 0; i < 3; i = i + 1) {
			g(i);
		}
		h(0);
	`, `
		let i = 0;
		while (true) {
			if (!(i < 3)) {
				break;
			}
			g(i);
			i = i + 1;
		}
		h(0);
	`);

	// The bug this guards against: real `for`-loop semantics run `update` even when the body
	// `continue`s (only the REST of the body is skipped) -- but a bare `continue;`, lowered onto
	// the same while-shaped graph a plain `while` uses, would otherwise skip `update` entirely
	// (jumping straight to the re-test, past anything else in the same block, exactly like a real
	// while-loop's own continue). `continue`'s own handler re-walks a fresh clone of `update`
	// first, right before its own marker, so it still runs on the continue path too.
	check('for: continue still runs update before re-testing', `
		let sum = 0;
		for (let i = 0; i < 5; i = i + 1) {
			if (i === 2) {
				continue;
			}
			sum = sum + i;
		}
		h(sum);
	`, `
		let sum = 0;
		let i = 0;
		while (true) {
			if (!(i < 5)) {
				break;
			}
			var t0 = i + 1;
			if (i === 2) {
				i = t0;
				continue;
			}
			sum = sum + i;
			i = t0;
		}
		h(sum);
	`);

	// `continue` inside a `switch` nested in a `for` must still re-run the FOR's own `update` --
	// `switch` pushes nothing onto the loop-context stack that tracks which update to re-run (it's
	// not a loop and has no update of its own), so it's correctly transparent here, same as it is
	// to a real `continue` at runtime. __match0/__hit both print for the same reason as the earlier
	// `while`-nested version of this test: `continue` is a real jump, not switchIsNoOp-eligible, and
	// each is genuinely read twice (its own case's test, plus default's own exclusion test).
	check('for: continue inside a nested switch still runs the enclosing loop\'s update', `
		for (let i = 0; i < 5; i = i + 1) {
			switch (i) {
				case 2:
					continue;
				default:
					g(i);
			}
		}
	`, `
		let i = 0;
		while (true) {
			if (!(i < 5)) {
				break;
			}
			let __disc_var8 = i;
			let __match0_var8 = __disc_var8 === 2;
			let __hit_var8 = false;
			var t0 = i + 1;
			switch (__disc_var8) {
				case 2:
					i = t0;
					continue;
				default:
					g(i);
			}
			i = t0;
		}
	`);

	// `try`/`catch` didn't exist at all before this batch (and needed `throw` alongside it to be
	// testable at all). Reconstructed as a real `try {...} catch (e) {...}` -- no rotation or
	// synthetic wrapper needed, unlike a loop or switch, since try/catch is already exactly the
	// shape it needs to be. Deliberately doesn't model implicit exceptions from an ordinary call
	// that might itself throw (see BuildVSDG's 'try' case) -- only an explicit `throw` is a
	// control-flow event in the graph; nothing here reorders a `try` body's own statements, so real
	// JS's own exception routing at runtime is unaffected either way. `x`'s merged value after the
	// try/catch has no printable condition to build a ternary from the way an if/else's gamma can
	// (there's no boolean "did it throw" to write), so each branch keeps and prints its own
	// `x = ...;` under the same name instead (a new `except` node exists purely so GCM schedules
	// `h(x)` no earlier than whichever branch actually ran).
	check('try/catch: merged value has no printable condition, so each branch keeps its own name', `
		let x = 0;
		try {
			x = f();
		} catch (e) {
			x = 0;
		}
		h(x);
	`, `
		let x;
		try {
			x = f();
		} catch (e) {
			x = 0;
		}
		h(x);
	`);

	// An explicit `throw` is a break/continue-style marker carrying a real value (its own operand,
	// resolved at print time) -- `catch (e)`'s own parameter is opaque and externally provided, no
	// different from a function parameter, with no connection to any computation inside `try`.
	check('try/catch: throw carries its own value into the catch parameter', `
		try {
			g(1);
			throw 99;
		} catch (e) {
			h(e);
		}
	`, `
		try {
			g(1);
			throw 99;
		} catch (e) {
			h(e);
		}
	`);

	// `finally` runs after the try/catch merge, walked like ordinary code -- NOT modeling "runs on
	// every exit path" at the graph level at all (see BuildVSDG's 'try' case for why real JS's own
	// finally semantics already guarantee this for free, once it's reconstructed as a REAL finally
	// clause). A `let`/const (or, as here, a reassignment read back afterward) declared directly in
	// `try`/`catch`/`finally`'s own body needs an extra scope layer with closeAndFlush -- unlike an
	// if's consequent/alternate, `s.block`/`s.handlerBody`/`s.finalizer` are plain statement arrays
	// with no enclosing 'block' AST node to filter locals the way if/else already benefits from;
	// without it, `catch`'s own parameter name leaked into the merge's diverged-variable
	// reconciliation and crashed on the branch that never bound it.
	check('try/catch/finally: finally sees the merged value and always runs', `
		let x = 0;
		try {
			x = f();
		} catch (e) {
			x = 0;
		} finally {
			g(x);
		}
		h(x);
	`, `
		let x;
		try {
			x = f();
		} catch (e) {
			x = 0;
		} finally {
			g(x);
		}
		h(x);
	`);

	// `break` inside a `try` nested in a `while` correctly propagates out to the loop -- try/catch
	// introduces no break-target of its own (unlike `switch`), so this needs no special handling at
	// all beyond what break_scope/buildLoop already provide; the printed `break;` inside `try`
	// already routes to the enclosing `while` via real JS semantics, exactly like it would with no
	// try/catch there at all.
	check('try/catch: break inside try still exits the enclosing loop', `
		let i = 0;
		while (i < 3) {
			try {
				g(i);
				if (i === 1) {
					break;
				}
			} catch (e) {
				h(0);
			}
			i = i + 1;
		}
	`, `
		let i = 0;
		while (true) {
			if (!(i < 3)) {
				break;
			}
			try {
				g(i);
				if (i === 1) {
					break;
				}
			} catch (e) {
				h(0);
			}
			i = i + 1;
		}
	`);

	// A call/new's own callee used to be printed verbatim, straight from the raw source AST, on the
	// (mostly true) assumption that a callee has nothing a graph resolution would change -- wrong
	// specifically when the callee's own OBJECT is itself an effect: `f()` here is materialized as
	// its own statement (its sole consumer is the pure 'member' node `f().m`, not another effect or
	// a rebind, so isInlinableEffect can't defer it the way `g(h())` safely does), but the callee was
	// still reprinted from the untouched original AST -- calling `f()` a SECOND time. Resolving the
	// callee through the graph (buildEffectExpr) picks up the same `t0` the statement already
	// declared instead of re-embedding the raw source.
	check('call: effectful object of a member callee is not re-run', `
		h(f().m());
	`, `
		var t0 = f();
		h(t0.m());
	`);

	// optimizeStructuralCSE: two separately-written but structurally identical pure expressions
	// (not two reads of the same variable -- BuildVSDG creates a fresh graph node per AST
	// occurrence) collapse to one shared computation. Also regression-covers a real bug found
	// wiring Optimize into this pipeline: `a`/`b` are function PARAMETERS, so the shared node's own
	// scheduleEarly position naturally lands at the function_decl's own block (function_decl_0),
	// which regionRootOf used to resolve to block_entry -- the TOP-LEVEL program, not the function
	// -- excluding both real consumers from scheduleLate's own LCA constraint and stranding the
	// shared value outside the function it belongs to, printing `var t0 = a * b;` at the top level
	// and referencing parameters that don't exist there (a real ReferenceError, not cosmetic).
	check('structural CSE: two separately-written identical expressions share one computation', `
		function f(a, b) {
			g(a * b);
			h(a * b);
		}
	`, `
		function f(a, b) {
			var t0 = a * b;
			g(t0);
			h(t0);
		}
	`);

	// Loop-invariant hoisting: neither `a` nor `b` is ever reassigned inside the loop, so `a * b`
	// is provably the same value every iteration. scheduleEarly recognizes this via a muValue's own
	// trivial self-feedback (see its own comment in applyGlobalCodeMotion) and stops the mu-tie from
	// flooring the value's placement inside the loop; needsTemp's own loop-depth check (comparing a
	// node's scheduled depth against its consumer's) is what actually forces it to materialize at
	// its new, shallower position instead of silently being recomputed every iteration anyway via
	// ordinary single-use inlining.
	check('loop-invariant hoisting: a*b never changes across iterations, computed once before the loop', `
		let a = 2;
		let b = 3;
		let s = 0;
		while (cond) {
			s = s + a * b;
		}
	`, `
		let a = 2;
		let b = 3;
		let s = 0;
		var t0 = a * b;
		while (true) {
			if (!cond) {
				break;
			}
			s = s + t0;
		}
	`);

	if (failures) {
		console.error(`${failures} failure(s)`);
		process.exit(1);
	}
	console.log('all vsdg tests passed');
}

if (require.main === module)
	main().catch(e => { console.error(e); process.exit(1); });
