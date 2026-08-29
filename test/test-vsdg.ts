import assert from 'assert';
import * as TS from '../src/examples/TS/ts-parser';
import { BuildVSDG, applyGlobalCodeMotion, blocksToAST } from '../src/examples/TS/vsdg';
import { Output as CodeOutput } from '../src/examples/TS/tocode';

// Regression suite for vsdg.ts's BuildVSDG -> applyGlobalCodeMotion -> blocksToAST pipeline: builds
// the VSDG for a program, schedules it, and reconstructs source from the result, then checks the
// EXACT printed output against a known-correct expected string. Each test below traces back to a
// real bug found (and fixed) while getting this pipeline working; the comment on each names the bug
// so a future regression here points straight at what broke.
//
// Calls named `pureXxx` are treated as pure (no state threading) by BuildVSDG's temporary
// naming-convention placeholder for real purity analysis (not implemented yet) -- see the `pure`
// check in BuildVSDG's 'call' case. Every other call name is treated as effectful.

const printer = new CodeOutput();

function compile(src: string): string {
	const prog		= TS.parse(src);
	const graph		= BuildVSDG(prog.body);
	const { blockIds, blockControl } = applyGlobalCodeMotion(graph);
	const stmts = blocksToAST(blockIds, blockControl, graph);
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

async function main() {
	let failures = 0;
	const check = (name: string, src: string, expected: string) => {
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
	// branches before anything reads it, so it becomes `let x;` instead of `let x = 1;`). `a`'s own
	// declared value inlines too, by the same single-consumer rule as any other local: its only
	// reader is the merge's own condition. The merge itself (`x`) has exactly one real reader too
	// (`h(x)`) -- named gammas are just as inlinable as an ordinary reassignment (isInlinableSlot),
	// so it inlines straight into `h(...)` instead of needing its own `x = ...;` statement.
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
		let x;
		let a;
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
		let a;
		let b;
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
		let a = 1;
		if (a) {
			f(1);
			g(2);
		} else {
			h(3);
		}
		k(a);
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
	// (only `h(x)` reads it), so it inlines too, straight into `h(...)`.
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
		let x;
		let a = 1;
		if (a) {
			
		} else {
			f(9);
		}
		h(a ? 2 : 3);
	`);

	// A reassignment sandwiched between two effects in the SAME branch (`x = 2; f(x); x = 3;`):
	// ordering must hold within a branch too, not just across one. `x = 2;` itself inlines away
	// (its only reader is the very next statement, in the same block, so `x` never needs to
	// observably hold 2 -- f(x) becomes f(2), same as an anonymous single-use temp would). `x`'s
	// declared initial value (1) and the branch's final value (3) are each single-consumer pure
	// values too -- both inline straight into the merge ternary, which is what actually needs them
	// (the `if` has no `else`, so the false path genuinely falls through to x's original value of 1).
	// The merge itself has exactly one real reader (`h(x)`), so it inlines too.
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
		let x;
		let a = 1;
		if (a) {
			f(2);
		}
		h(a ? 3 : 1);
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
		let x;
		let a;
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
			if ((i % 2) === 0) {
				i = i + 1;
				continue;
			}
			n = n + i;
			i = i + 1;
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
		let x;
		let a;
		h(1 ? 10 : 2 ? 20 : 30);
	`);

	// `switch` didn't exist as a statement type at all before this batch (and had a prerequisite:
	// break/continue support, above). It's lowered into an ordinary `if`/`while` cascade with a
	// synthetic `__hit` fallthrough flag, fed back through `recurse` -- reusing the if-handler's own
	// exit-tracking/gamma machinery and the while-handler's own mu/theta/loop-rotation machinery
	// entirely as-is. Building this exposed two genuinely pre-existing, unrelated bugs, both fixed
	// alongside it: (1) `walker.ts`'s `isType` guard mis-routed ANY bare expression-level `literal`
	// node (e.g. `while (true)`'s own test) to the no-op type-walker, since a type-level literal type
	// and an expression-level literal value are IDENTICAL shapes with no structural way to tell them
	// apart -- fixed by letting `recurse` take an explicit `'expression'` hint that bypasses the
	// shape-based guess (a real, general bug: even a hand-parsed `if (true) {...}` hit it, nothing to
	// do with switch specifically); (2) the discriminant's own wrapper node was built by hand
	// (`makeNode`/`connectValue`) but never threaded into the state chain via `rebindVar`, so its own
	// `let __disc = ...;` declaration never printed even though every case read its name.
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
		let x = 1;
		let __disc_var4 = x;
		let __match0_var4 = __disc_var4 === 1;
		let __match1_var4 = __disc_var4 === 2;
		let __hit_var4 = false;
		while (true) {
			if (!true) {
				break;
			}
			if (__hit_var4 || __match0_var4) {
				__hit_var4 = true;
				g(1);
				break;
			}
			if (__hit_var4 || __match1_var4) {
				__hit_var4 = true;
				g(2);
				break;
			}
			var t0 = __hit_var4 || !(__match0_var4 || __match1_var4);
			if (t0) {
				__hit_var4 = t0 ? true : __hit_var4;
				g(99);
			}
			break;
		}
		h(x);
	`);

	// A case with no `break` falls straight into the next one (the classic switch fallthrough
	// footgun) -- once `__hit` is set by case 1 matching, every later case's own test becomes
	// irrelevant, so cases 2 and 3 both run (case 3's own `break` then stops it before case 4).
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
		let x = 2;
		let __disc_var4 = x;
		let __match0_var4 = __disc_var4 === 1;
		let __match1_var4 = __disc_var4 === 2;
		let __match2_var4 = __disc_var4 === 3;
		let __match3_var4 = __disc_var4 === 4;
		let __hit_var4 = false;
		while (true) {
			if (!true) {
				break;
			}
			var t0 = __hit_var4 || __match0_var4;
			if (t0) {
				g(1);
			}
			__hit_var4 = t0 ? true : __hit_var4;
			var t1 = __hit_var4 || __match1_var4;
			if (t1) {
				g(2);
			}
			__hit_var4 = t1 ? true : __hit_var4;
			if (__hit_var4 || __match2_var4) {
				__hit_var4 = true;
				g(3);
				break;
			}
			var t2 = __hit_var4 || __match3_var4;
			if (t2) {
				__hit_var4 = t2 ? true : __hit_var4;
				g(4);
			}
			break;
		}
		h(x);
	`);

	// `default` written FIRST must still only match when no other case does -- real switch
	// semantics are position-independent (default only wins when nothing else matches, wherever
	// it's written), unlike a naive "positional hit cascade" would give.
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
		let x;
		let __disc_var4 = 5;
		let __match1_var4 = __disc_var4 === 1;
		let __hit_var4 = false;
		while (true) {
			if (!true) {
				break;
			}
			if (__hit_var4 || !__match1_var4) {
				__hit_var4 = true;
				g(0);
				break;
			}
			if (__hit_var4 || __match1_var4) {
				__hit_var4 = true;
				g(1);
				break;
			}
			break;
		}
	`);

	if (failures) {
		console.error(`${failures} failure(s)`);
		process.exit(1);
	}
	console.log('all vsdg tests passed');
}

main().catch(e => { console.error(e); process.exit(1); });
