import assert from 'assert';
import * as PY from '../dist/examples/PY/py-parser';
import { BuildVSDG, Optimize, BuildProgram } from '../dist/examples/PY/vsdg';
import { applyGlobalCodeMotion } from '../dist/examples/vsdg';
import { printer as codePrinter } from '../dist/examples/PY/printer';

// Regression suite for the Python half of the language-neutral VSDG
// (src/examples/vsdg.ts + src/examples/PY/vsdg.ts): build the graph, schedule it, reconstruct
// Python, and check the EXACT printed output.
//
// The harness is test-vsdg.ts's; the 4-space indent is PY/printer's own unit. Expectations below
// were each read off a verified run, not guessed -- and where a construct is deliberately NOT
// modelled, the expectation encodes the *verbatim fallback* (see the last group), which is the
// property that matters: an unmodelled statement must still print, exactly once, with everything it
// references still declared.
//
// Calls named `pureXxx` are treated as pure (no state threading) by the temporary naming-convention
// placeholder for real purity analysis -- see the `pure` check in the builder's 'call' case.

const printer = codePrinter();

function compile(src: string): string {
	// Python's grammar is indentation-sensitive, so the source has to be dedented first -- the
	// template literals below are written at this file's own tab-indented level.
	const prog		= PY.parse(dedent(src));
	const graph		= BuildVSDG(prog.body);
	Optimize(graph);
	const { blocks, blockIds } = applyGlobalCodeMotion(graph);
	const stmts		= BuildProgram(graph, blocks, blockIds);
	return printer.statements(stmts).trim();
}

function indent(s: string) {
	return s.split('\n').map(line => '    ' + line).join('\n');
}

// Expected-output template literals are written indented with tabs (this file's own convention);
// strips the common leading whitespace, then converts each remaining leading tab into Python's own
// 4-space unit, so the literal's formatting is irrelevant to the comparison.
function dedent(s: string): string {
	const lines		= s.replace(/^\n/, '').replace(/\n[ \t]*$/, '').split('\n');
	const indents	= lines.filter(l => l.trim().length > 0).map(l => l.match(/^[ \t]*/)![0].length);
	const min		= indents.length ? Math.min(...indents) : 0;
	return lines.map(l => {
		const rest			= l.slice(min);
		const leadingTabs	= rest.match(/^\t*/)![0].length;
		return '    '.repeat(leadingTabs) + rest.slice(leadingTabs);
	}).join('\n');
}

export async function main() {
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

	// ------------------------------------------------------------------
	//  Values, folding, and single-use inlining
	// ------------------------------------------------------------------

	// Nesting is where double-walking shows up: a call's argument walked twice would compile to two
	// separate effect nodes, i.e. actually calling `h` twice.
	check('nested call: no double-processing', `
		g(h())
	`, `
		g(h())
	`);

	// `x`'s declared value is overwritten before anything reads it, so the FIRST assignment drops.
	// Python has no declaration syntax, so `x = 1` here is the binding's declaration (the builder
	// picks `var` vs `mutation` from whether the name is already bound) and a dead one prints nothing.
	check('dead initializer: reassigned before any read', `
		x = 1
		x = 2
		print(x)
	`, `
		print(2)
	`);

	check('constant folded', `
		x = 2 + 3
		print(x)
	`, `
		print(5)
	`);

	// `x` has one reader, which recomputes the pure initializer inline; `y` in turn inlines into
	// `print`. Also exercises foldConstants over the `+` before inlining.
	check('single-use locals inline', `
		x = 2 + 3
		y = x * 2
		print(y)
	`, `
		print(5 * 2)
	`);

	// A per-variable merge with no condition to print becomes a conditional EXPRESSION -- Python
	// spells `cond ? a : b` as `a if cond else b`.
	check('if/else merged value becomes a conditional expression', `
		if a:
			x = 1
		else:
			x = 2
		print(x)
	`, `
		print(1 if a else 2)
	`);

	check('conditional expression', `
		x = a if b else c
		print(x)
	`, `
		print(a if b else c)
	`);

	// `compare` folds too, which is what lets a constant-conditioned branch die.
	check('constant comparison folds and the dead branch is eliminated', `
		if 1 == 1:
			g()
		else:
			h()
	`, `
		g()
	`);

	check('chained comparison threads every operand', `
		x = a < b < c
		print(x)
	`, `
		print(a < b < c)
	`);

	check('containers thread their elements', `
		x = [1, 2]
		y = {"a": 1}
		print(x)
	`, `
		print([1, 2])
	`);

	// ------------------------------------------------------------------
	//  Loops
	// ------------------------------------------------------------------

	// Same loop-rotation shape the TS dialect produces: the exit test needs values only available
	// once inside the body, so `while (cond)` is structurally impossible and becomes
	// `while True: if not cond: break; ...`.
	check('while loop: rotated, binding kept out of the loop', `
		i = 0
		while i < 10:
			g(i)
			i = i + 1
	`, `
		i = 0
		while True:
			if not i < 10:
				break
			g(i)
			i = i + 1
	`);

	// Python's `for` has no exit CONDITION -- exhaustion is a raised StopIteration -- so it lowers to
	// an explicit iterator loop with a per-loop sentinel. Deliberately not a try/except: the target
	// would then be bound in only one of the handler's two branches, and no merge can reconcile a
	// name that exists on just one side. The `__missN`/`__itN`/`__rN` numbering comes from the
	// builder's own id counter, so it is exact but internal -- a change here is a change there.
	check('for loop: desugared to an explicit iterator loop', `
		for x in items:
			g(x)
	`, `
		__miss1 = object()
		__it1 = iter(items)
		while True:
			__r1 = next(__it1, __miss1)
			if __r1 is __miss1:
				break
			g(__r1)
	`);

	check('for loop: tuple target still binds', `
		for a, b in pairs:
			g(a, b)
	`, `
		__miss1 = object()
		__it1 = iter(pairs)
		while True:
			__r1 = next(__it1, __miss1)
			if __r1 is __miss1:
				break
			a, b = __r1
			g(a, b)
	`);

	// ------------------------------------------------------------------
	//  Functions and classes
	// ------------------------------------------------------------------

	check('funcdef: signature and body round-trip', `
		def f(a, b):
			return a + b
	`, `
		def f(a, b):
			return a + b
	`);

	check('funcdef: an early return prints in place', `
		def f(a):
			if a:
				return 1
			return 2
	`, `
		def f(a):
			if a:
				return 1
			return 2
	`);

	// A closure reads a name from the enclosing function's scope through the graph, and the
	// reassignment/binding still has to print inside the right function.
	check('closure over an enclosing local', `
		def outer():
			x = 1
			def inner():
				g(x)
			return inner
	`, `
		def outer():
			x = 1
			def inner():
				g(x)
			return inner
	`);

	// A method body is its own function-scoped region rooted at the class anchor.
	check('class method body is rebuilt through the class anchor', `
		class C:
			def m(self):
				g()
	`, `
		class C:
			def m(self):
				g()
	`);

	// `lambda` reuses the same 'function' entry an arrow does, with an expression body; its single
	// consumer inlines it verbatim.
	check('lambda inlines into its single consumer', `
		f = lambda x: x + 1
		print(f(1))
	`, `
		print((lambda x: x + 1)(1))
	`);

	// ------------------------------------------------------------------
	//  try / except
	// ------------------------------------------------------------------

	// The handler's matched TYPE is threaded like any other expression, so it survives the
	// reconstruction rather than degrading to a bare `except:`.
	check('try/except keeps its handler type', `
		try:
			g()
		except E:
			h()
	`, `
		try:
			g()
		except E:
			h()
	`);

	check('try/except with a return in each branch', `
		def f():
			try:
				return g()
			except E:
				return h()
	`, `
		def f():
			try:
				return g()
			except E:
				return h()
	`);

	// ------------------------------------------------------------------
	//  Statements this dialect prints verbatim
	// ------------------------------------------------------------------
	// The property under test is the same one every time: the statement still appears EXACTLY ONCE,
	// and anything it references is still declared. Getting this wrong does not fail loudly -- an
	// earlier version of the verbatim fallback either dropped the construct entirely (running its
	// body unconditionally) or printed its insides a second time outside it.

	check('while/else: unmodelled, prints once and keeps its binding', `
		x = 1
		while x < 10:
			g()
		else:
			h()
	`, `
		x = 1
		while x < 10:
			g()
		else:
			h()
	`);

	check('with: unmodelled, prints once and keeps what it references', `
		with open("f") as f:
			g(f)
	`, `
		with open("f") as f:
			g(f)
	`);

	check('assert: unmodelled, and its binding must survive', `
		x = 1
		assert x > 0
	`, `
		x = 1
		assert x > 0
	`);

	// A name rebound INSIDE a verbatim statement is only defined by that statement's own text, so a
	// later read must resolve to the bare name rather than to a value the graph never printed.
	// `x = 1` is genuinely dead here (the verbatim body overwrites it before any read), so it drops --
	// which is fine in Python, where `x = 2` needs no prior declaration.
	check('reading a name a verbatim statement rebound', `
		x = 1
		with open("f"):
			x = 2
		print(x)
	`, `
		with open("f"):
			x = 2
		print(x)
	`);

	// A bare string is a docstring, not dead arithmetic. (The printer re-quotes it with plain `"`
	// rather than the source's `"""`, which is its own choice and still a legal docstring.)
	check('docstring is preserved', `
		"""Module doc."""
		x = 1
		print(x)
	`, `
		"Module doc."
		print(1)
	`);

	// ------------------------------------------------------------------
	//  Calls and mutations
	// ------------------------------------------------------------------

	// `pureXxx` is the placeholder for real purity analysis: a pure call isn't threaded into the
	// state chain, so it inlines like any other single-use value.
	check('pure call stays a pure value', `
		x = purefoo(1)
		print(x)
	`, `
		print(purefoo(1))
	`);

	// An augmented assignment is not `plainAssign` (it reads its own target), so it always prints.
	check('augmented assignment keeps both statements', `
		x = 1
		x += 2
		print(x)
	`, `
		x = 1
		x += 2
		print(x)
	`);

	// `x: int = 5` is a declaration with an annotation; its initializer is pure and inlined into the
	// single reader, so the whole annotation drops.
	check('annotated declaration inlines its initializer', `
		x: int = 5
		print(x)
	`, `
		print(5)
	`);

	// An f-string's interpolated expressions are real value inputs, so a binding they read is kept.
	check('f-string threads its interpolations', `
		name = "bob"
		print(f"hi {name}!")
	`, `
		print(f'hi {"bob"}!')
	`);

	if (failures) {
		console.error(`${failures} failure(s)`);
		process.exit(1);
	}
	console.log('all vsdg-py tests passed');
}

if (require.main === module)
	main().catch(e => { console.error(e); process.exit(1); });
