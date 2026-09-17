import * as CPP from '../dist/examples/CPP/cpp-parser';
import { BuildVSDG, Optimize, BuildProgram, isDefinition } from '../dist/examples/CPP/vsdg';
import { applyGlobalCodeMotion } from '../dist/examples/vsdg';
import { printer as codePrinter } from '../dist/examples/CPP/printer';

// Regression suite for the C++ half of the language-neutral VSDG (src/examples/vsdg.ts +
// src/examples/CPP/vsdg.ts): build the graph, schedule it, reconstruct C++, and check the EXACT
// printed output.
//
// The harness is test-vsdg.ts's, with one C++-only wrinkle: the top level is a list of DEFINITIONS,
// not statements, so each item is handed to the printer's own entry point for what it is
// (`isDefinition`) -- see CPP/vsdg.ts's header on why the core's `S` is the widened `Definition | Stmt`.
//
// Every expectation below was read off a verified run, not guessed. Where a construct is deliberately
// NOT modelled, the expectation encodes the *verbatim fallback* -- which is the property that matters:
// an unmodelled statement still prints, exactly once, with everything it references still declared.
//
// Calls named `pureXxx` are treated as pure (no state threading) by the temporary naming-convention
// placeholder for real purity analysis -- see the `pure` check in the builder's 'call' case.

const printer = codePrinter();

async function compile(src: string): Promise<string> {
	// `parse` is async (the preprocessor's include resolver is) -- hence this suite's async harness.
	const prog		= await CPP.parse(src, { filename: 'suite.cpp', knownTypes: ['S', 'Point'] });
	const graph		= BuildVSDG(prog.body);
	Optimize(graph);
	const { blocks, blockIds } = applyGlobalCodeMotion(graph);
	return BuildProgram(graph, blocks, blockIds)
		.map(item => isDefinition(item)
			? printer.definition(item as Parameters<typeof printer.definition>[0])
			: printer.statement(item as Parameters<typeof printer.statement>[0]))
		.join('\n')
		.trim();
}

function indent(s: string) {
	return s.split('\n').map(line => '    ' + line).join('\n');
}

// Expected-output template literals are written tab-indented (this file's own convention); strips the
// common leading whitespace, then converts each remaining leading tab into the C++ printer's own
// 2-space unit, so the literal's formatting is irrelevant to the comparison.
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

let failures = 0;

async function check(name: string, src: string, expected: string) {
	let actual: string;
	try {
		actual = await compile(src);
	} catch (e) {
		++failures;
		console.log(`FAIL - ${name}\n  threw: ${e}`);
		return;
	}
	if (actual === expected) {
		console.log(`ok - ${name}`);
		return;
	}
	++failures;
	console.log(`FAIL - ${name}`);
	console.log('  expected:\n' + indent(expected));
	console.log('  actual:\n' + indent(actual));
}

async function main() {
	await check('main returns a literal', 'int main() { return 0; }\n', dedent(`
		int main() {
		  return 0;
		}
	`));

	await check('parameter is bound and read by name', 'int f(int x) { return x + 1; }\n', dedent(`
		int f(int x) {
		  return x + 1;
		}
	`));

	await check('top-level initialised declaration', 'int g = 5;\nint main() { return g; }\n', dedent(`
		int g = 5;
		int main() {
		  return g;
		}
	`));

	await check('while with a loop-carried variable', 'int main() { int i = 0; while (i < 10) { i = i + 1; } return i; }\n', dedent(`
		int main() {
		  int i = 0;
		  while (true) {
		    if (!(i < 10)) {
		      break;
		    }
		    i = i + 1;
		  }
		  return i;
		}
	`));

	await check('for desugars to a rotated while, update last', 'int main() { for (int i = 0; i < 10; i = i + 1) { g(); } return 0; }\n', dedent(`
		int main() {
		  int i = 0;
		  while (true) {
		    if (!(i < 10)) {
		      break;
		    }
		    g();
		    i = i + 1;
		  }
		  return 0;
		}
	`));

	await check('do-while keeps its own shape', 'int main() { int i = 0; do { i = i + 1; } while (i < 3); return i; }\n', dedent(`
		int main() {
		  int i = 0;
		  do {
		    i = i + 1;
		  } while (i < 3);
		  return i;
		}
	`));

	await check('call statement, and the declaration it needs', 'void h();\nint main() { h(); return 0; }\n', dedent(`
		void h();
		int main() {
		  h();
		  return 0;
		}
	`));

	await check('two branches with real effects keep a real if/else', 'int main() { int x = 1; if (x) { h(); } else { h(); } return 0; }\n', dedent(`
		int main() {
		  int x = 1;
		  if (x) {
		    h();
		  } else {
		    h();
		  }
		  return 0;
		}
	`));

	await check('nested loops', 'int main() { int i = 0; while (i < 3) { int j = 0; while (j < 3) { j = j + 1; } i = i + 1; } return i; }\n', dedent(`
		int main() {
		  int i = 0;
		  while (true) {
		    if (!(i < 3)) {
		      break;
		    }
		    int j = 0;
		    while (true) {
		      if (!(j < 3)) {
		        break;
		      }
		      j = j + 1;
		    }
		    i = i + 1;
		  }
		  return i;
		}
	`));

	await check('a dead declaration is elided', 'int main() { int unused = 5; return 0; }\n', dedent(`
		int main() {
		  return 0;
		}
	`));

	// The declaration goes, the CALL stays: eliding an initialiser whose value nobody reads must not
	// drop the effect that produced it.
	await check('an effectful initialiser survives its dead declaration', 'int main() { int v = h(); return 0; }\n', dedent(`
		int main() {
		  h();
		  return 0;
		}
	`));

	await check('a read declaration keeps its initialiser', 'int main() { int v = h(); return v; }\n', dedent(`
		int main() {
		  int v = h();
		  return v;
		}
	`));

	// VERBATIM FALLBACK GROUP -- an unmodelled construct must still print, once, with everything it
	// mentions still declared. The class and the switch both take that path.

	await check('a class prints verbatim', 'class Point { public: int x; };\nint main() { return 0; }\n', dedent(`
		class Point {
		  public:
		  int x;
		};
		int main() {
		  return 0;
		}
	`));

	// A switch the builder can't regroup (here a statement before the first label, which C++ allows
	// and `switchCasesOf` refuses) still prints verbatim -- and the bare `x` its discriminant mentions
	// still needs a reader, or `int x = 1;` is elided and the printed switch reads nothing declared.
	await check('a verbatim switch keeps the declaration it reads', 'int main() { int x = 1; switch (x) { g(); case 1: return 1; } return 0; }\n', dedent(`
		int main() {
		  int x = 1;
		  switch (x) {
		    g();
		    case 1: return 1;
		  }
		  return 0;
		}
	`));

	// `S *p = 0;` is ambiguous to the grammar (an unknown type name forks it into a pointer
	// declaration and a multiplication) and c-parser returns BOTH readings. Only the first is lowered
	// -- taking both ran the statement twice.
	await check('an ambiguous declarator is lowered once', 'int main() { int k = 1; S *p = 0; return p->x; }\n', dedent(`
		int main() {
		  S *p = 0;
		  return p->x;
		}
	`));

	// ---- `++` / `--` -- an unmodelled expression that still re-binds the NAME it rewrites ----
	// The expression stays opaque (`lowerUnmodelledMutation`): `x++` on a class type is a real
	// `operator++` call, and its value is a COPY of the old one, so `auto t0 = x; x++;` is not the same
	// program as `g(x++)` and this pass has no types to tell the two apart. So the first two cases
	// here only check the text survives; the last two are why the name is re-bound at all.

	await check('inc/dec print verbatim, in every position', 'int f(int i) { i++; auto a = i++; return g(i++) + a; }\n', dedent(`
		int f(int i) {
		  i++;
		  auto a = i++;
		  return g(i++) + a;
		}
	`));

	await check('inc/dec on a member target, both forms', 'int f(S s) { s.x++; --s.x; return s.x; }\n', dedent(`
		int f(S s) {
		  s.x++;
		  --s.x;
		  return s.x;
		}
	`));

	await check('inc/dec survive a for-update and a loop body', 'int f(int i) { int s = 0; for (int k = 0; k < 3; i++) { s = s + i++; } return s; }\n', dedent(`
		int f(int i) {
		  int k = 0;
		  int s = 0;
		  while (true) {
		    if (!(k < 3)) {
		      break;
		    }
		    s = s + i++;
		    i++;
		  }
		  return s;
		}
	`));

	// Without the re-bind, both `i * 2` reads hang off the SAME `var` node -- still value-equal, since
	// the unmodelled increment never touched it -- so CSE merges them into one temp, scheduled at their
	// lowest common ancestor, i.e. ABOVE the increment: `h(t0)` holding the pre-increment product.
	await check('an increment between two reads is not merged across', 'int f(int i) { g(i * 2); i++; h(i * 2); }\n', dedent(`
		int f(int i) {
		  g(i * 2);
		  i++;
		  h(i * 2);
		}
	`));

	await check('... and the same for the prefix form', 'int f(int i) { g(i * 2); ++i; h(i * 2); }\n', dedent(`
		int f(int i) {
		  g(i * 2);
		  ++i;
		  h(i * 2);
		}
	`));

	// A branch pair whose only content is the value it merges -- `r = g(x)` in each arm -- reconstructs
	// at that value's own consumer, leaving neither arm a statement of its own: the mutations behind a
	// merged value hang off the VALUE edge, not the state chain. The anchoring `if` used to print
	// anyway, an empty `if (c) { } else { }` repeating the condition the merged value already prints.
	await check('a branch pair with nothing to print leaves no empty if', 'int f(int x, int y, int c) { int r = 0; if (c) r = g(x); else r = h(y); return r; }\n', dedent(`
		int f(int x, int y, int c) {
		  int r = 0;
		  return c ? r = g(x) : (r = h(y));
		}
	`));

	await check('... the same shape with ++ in both arms', 'int f(int i, int c) { int a = 0; if (c) a = i++; else a = i++; return a; }\n', dedent(`
		int f(int i, int c) {
		  int a = 0;
		  return c ? a = i++ : (a = i++);
		}
	`));

	// A store nothing reads is dead, but its RIGHT-HAND SIDE is not -- dropping the assignment used to
	// drop `g(x)` with it, since the call had deferred to the assignment and the assignment then went.
	await check('a dead store still evaluates its right-hand side', 'int f(int x) { int r = 0; r = g(x); return 0; }\n', dedent(`
		int f(int x) {
		  int r = 0;
		  g(x);
		  return 0;
		}
	`));

	await check('... and so does a dead store in each arm of an if', 'int f(int x, int y, int c) { int r = 0; if (c) r = g(x); else r = h(y); return 0; }\n', dedent(`
		int f(int x, int y, int c) {
		  int r = 0;
		  if (c) {
		    g(x);
		  } else {
		    h(y);
		  }
		  return 0;
		}
	`));

	// An IMPURE condition whose value is merged across the branches: `g()` is what the `if` tested, and
	// the merged `a` prints as a ternary -- so the call has to be materialised. Before this, the ternary's
	// own condition printed the same call a SECOND time (`if (g()) { } else { } return g() ? ...`).
	await check('an impure condition of a merged value runs once', 'int f(int i) { int a = 0; if (g()) a = i++; else a = i++; return a; }\n', dedent(`
		int f(int i) {
		  int a = 0;
		  auto t0 = g();
		  return t0 ? a = i++ : (a = i++);
		}
	`));

	// `++` on a plain NAME claims more than that: a builtin `++`'s only effect is rewriting the name, so
	// with nothing reading it the whole increment is a dead store (see the node's own `mutatesBindingId`).
	// A member target claims NOTHING -- an `operator[]`/`operator++` behind `s.x++` can do anything -- so
	// that one prints even with nothing to observe it.
	await check('a dead increment on a name is a dead store', 'int f(int i) { i++; return 0; }\n', dedent(`
		int f(int i) {
		  return 0;
		}
	`));

	await check('... but a dead increment on a member target still prints', 'int f(S s) { s.x++; return 0; }\n', dedent(`
		int f(S s) {
		  s.x++;
		  return 0;
		}
	`));

	// The rest of `++`'s live shapes, pinned together because this is where the two miscompiles above were
	// found: an increment whose TEXT is what carries it can only ever be right if every position it can
	// appear in is tested. In a loop TEST it must re-evaluate on every iteration (the rotated-while idiom), and in
	// a ternary/argument position each increment keeps its own node -- two identical `i++` texts must never
	// be CSE-merged into one, which is why effects are outside CSE entirely.
	await check('inc/dec in a loop test re-evaluates each iteration', 'int f(int i) { int s = 0; while (i++ < 3) { s = s + i; } return s; }\n', dedent(`
		int f(int i) {
		  int s = 0;
		  while (true) {
		    if (!(i++ < 3)) {
		      break;
		    }
		    s = s + i;
		  }
		  return s;
		}
	`));

	await check('inc/dec as a ternary condition, and as two arguments', 'int f(int i) { return g(i++, i++) + (i++ ? 1 : 2); }\n', dedent(`
		int f(int i) {
		  return g(i++, i++) + (i++ ? 1 : 2);
		}
	`));

	await check('two increments in one expression keep their own nodes', 'int f(int i) { int a = i++ + i++; return a; }\n', dedent(`
		int f(int i) {
		  int a = i++ + i++;
		  return a;
		}
	`));

	await check('the pre-increment value is still readable afterwards', 'int f(int i) { int a = i++; int b = a + i; return b; }\n', dedent(`
		int f(int i) {
		  int a = i++;
		  int b = a + i;
		  return b;
		}
	`));

	// KNOWN WART (cosmetic, not a miscompile): the chain rule is not transitive. The second increment is
	// dropped (nothing reads `i` afterwards), but the first is kept because that second one READS it -- and
	// a dropped reader still counts as a reader. Unobservable either way (`i` is a dead parameter), just odd.
	await check('KNOWN WART: one of two dead increments survives', 'int f(int i) { i++; i++; return 0; }\n', dedent(`
		int f(int i) {
		  i++;
		  return 0;
		}
	`));

	// ---- constant folding (cppDialect's own "C++ constant folding" section) ----
	// Each of these has a WRONG answer under js arithmetic, which is the point: the folder has to
	// implement C++'s own conversions, wrapping, truncation and UB rules, not reuse js's.

	await check('a constant condition collapses its branch', 'int f() { if (1 < 2) { g(); } else { h(); } return 0; }\n', dedent(`
		int f() {
		  g();
		  return 0;
		}
	`));

	// `0u - 1` is 4294967295u, not -1, so the comparison is false and `h()` wins. A folder using js
	// arithmetic picks `g()` instead.
	await check('an operand converts to the common type first', 'int f() { if (0u - 1 < 1u) { g(); } else { h(); } return 0; }\n', dedent(`
		int f() {
		  h();
		  return 0;
		}
	`));

	await check('integer division truncates toward zero', 'int f() { int x = -7 / 2; return x; }\n', dedent(`
		int f() {
		  int x = -3;
		  return x;
		}
	`));

	await check('unsigned arithmetic wraps and keeps its suffix', 'unsigned f() { unsigned u = 1u - 2u; return u; }\n', dedent(`
		unsigned f() {
		  unsigned u = 4294967295u;
		  return u;
		}
	`));

	await check('a long result keeps its own type', 'long f() { long v = 2L * 3L; return v; }\n', dedent(`
		long f() {
		  long v = 6L;
		  return v;
		}
	`));

	// `3.0`, never `3`: an integral result printed without a `.` would be an int literal, and this AST
	// would then read it back as one.
	await check('a floating result keeps a decimal point', 'double f() { double d = 1.0 + 2.0; return d; }\n', dedent(`
		double f() {
		  double d = 3.0;
		  return d;
		}
	`));

	await check('a char literal is an int after promotion', 'int f() { int c = \'a\' + 1; return c; }\n', dedent(`
		int f() {
		  int c = 98;
		  return c;
		}
	`));

	await check('a float operand rounds to float', 'int f() { if (1.5f + 1.5f == 3.0f) { g(); } return 0; }\n', dedent(`
		int f() {
		  g();
		  return 0;
		}
	`));

	// `1 && 2` is `true`, NOT 2 (js's answer): both operands convert to bool.
	await check('logical operators answer a bool', 'int f() { if (1 && 2) { g(); } return 0; }\n', dedent(`
		int f() {
		  g();
		  return 0;
		}
	`));

	await check('a literal keeps its own spelling', 'int u = 1u;\nfloat v = 1.5f;\nint f() { return u + v; }\n', dedent(`
		int u = 1u;
		float v = 1.5f;
		int f() {
		  return u + v;
		}
	`));

	// Refusals, each for a reason that would otherwise print a constant C++ never computes: integer
	// division by zero is UB, `INT_MAX + 1` is UB, `1 << 31` overflows a signed int.
	await check('division by zero is not folded', 'int f() { int z = 1 / 0; return z; }\n', dedent(`
		int f() {
		  int z = 1 / 0;
		  return z;
		}
	`));

	await check('signed overflow is not folded', 'int f() { int o = 2147483647 + 1; return o; }\n', dedent(`
		int f() {
		  int o = 2147483647 + 1;
		  return o;
		}
	`));

	await check('an overflowing shift is not folded', 'int f() { int s = 1 << 31; return s; }\n', dedent(`
		int f() {
		  int s = 1 << 31;
		  return s;
		}
	`));

	// A unary operator used to be discarded by c-parser's own rule (`-x` printed as `+x`), which also
	// made any fold under a prefix operator meaningless.
	await check('unary operators survive the round trip', 'int f(int x) { return !x; }\nint g(int y) { return -y; }\n', dedent(`
		int f(int x) {
		  return !x;
		}
		int g(int y) {
		  return -y;
		}
	`));

	// KNOWN PARSER BUG, pinned so that fixing the grammar has to show up here. c-parser's expression
	// grammar is the single-block-plus-`WithPrec` shape py-parser.ts's own header warns against: a
	// prefix operand absorbs the operator after it, and a same-level chain nests right-to-left. C++
	// computes these as 1 and 5; this pipeline's AST says -(1 + 2) and 10 - (2 - 3). Folding does not
	// cause it -- it only turns the mis-grouping into a visibly wrong constant instead of a wrong tree.
	await check('KNOWN BUG: a prefix operand absorbs the following operator', 'int f() { return -1 + 2; }\n', dedent(`
		int f() {
		  return -3;
		}
	`));

	await check('KNOWN BUG: a same-level chain nests right-to-left', 'int f() { return 10 - 2 - 3; }\n', dedent(`
		int f() {
		  return 11;
		}
	`));

	// ---- declarations that a surviving store still needs (C++ has no implicit declaration) ----

	// The merge prints as a ternary whose arms are the stores, so `x` is named in the output even
	// though nothing reads the declaration's own VALUE -- dropping it printed an undeclared `x`.
	await check('a stored-to name keeps its declaration across a branch merge', 'int f(int c) { int x = 1; if (c) { x = 2; } else { x = 3; } return x; }\n', dedent(`
		int f(int c) {
		  int x = 1;
		  return c ? x = 2 : (x = 3);
		}
	`));

	// Folding the branch away bypasses the gammaValue that held the name, so this is the case a
	// boundName lookup misses: only the store itself is left, and it still needs `x` declared.
	await check('a constant branch keeps the declaration of the name it stores to', 'int f() { int x = 1; if (0) { x = 2; } else { x = 3; } return x; }\n', dedent(`
		int f() {
		  int x = 1;
		  return x = 3;
		}
	`));

	// ---- lambdas: a value, but its body is its own region ----

	// The unmodelled-expression fallback used to descend into the body, so its statements were lowered
	// in the ENCLOSING function -- `auto g = [](int x) { return h(x); };` printed a bare outer `h(x);`.
	await check('a lambda body is lowered into its own region, not the enclosing function', 'int f() { auto g = [](int x) { return h(x); }; return g(1); }\n', dedent(`
		int f() {
		  auto g = [](int x) {
		    return h(x);
		  };
		  return g(1);
		}
	`));

	// The lambda's text still prints verbatim, so a name only IT mentions needs its own reader: `y` is
	// captured but never read in the body, and without that reader its declaration was elided.
	await check('a capture only the capture list mentions keeps its declaration', 'int f() { int y = 1; auto g = [&y]() { return 2; }; return 0; }\n', dedent(`
		int f() {
		  int y = 1;
		  [&y]() {
		    return 2;
		  };
		  return 0;
		}
	`));

	// ---- switch: the same if-cascade + break_scope reconstruction TS builds ----

	await check('switch: break exits the scope, default matches by exclusion', 'int f(int x) { switch (x) { case 1: g(1); break; case 2: g(2); break; default: g(99); } return 0; }\n', dedent(`
		int f(int x) {
		  auto __disc_5 = x;
		  switch (__disc_5) {
		    case 1: g(1);
		    break;
		    case 2: g(2);
		    break;
		    default: g(99);
		  }
		  return 0;
		}
	`));

	// No break in case 1: the `__hit` flag keeps case 2's own test irrelevant once it is set, which is
	// what makes fallthrough print as plain fallthrough.
	await check('switch: a case without break falls into the next', 'int f(int x) { switch (x) { case 1: g(1); case 2: g(2); break; default: g(99); } return 0; }\n', dedent(`
		int f(int x) {
		  auto __disc_5 = x;
		  switch (__disc_5) {
		    case 1: g(1);
		    case 2: g(2);
		    break;
		    default: g(99);
		  }
		  return 0;
		}
	`));

	// `case 1: case 2: g();` is a label whose own body IS the next label on this AST, so an empty case
	// chains onto what follows instead of printing a bare `case 1: ;`.
	await check('switch: empty cases chain onto the next label', 'int f(int x) { switch (x) { case 1: case 2: g(); break; default: break; } return 0; }\n', dedent(`
		int f(int x) {
		  auto __disc_5 = x;
		  switch (__disc_5) {
		    case 1: case 2: g();
		    break;
		    default: break;
		  }
		  return 0;
		}
	`));

	// C++ forbids jumping past a declaration's initialisation into its scope, so a case body that
	// DECLARES anything is wrapped in its own block -- and the builder scopes it to match.
	await check('switch: a declaration in a case gets its own block', 'int f(int x) { switch (x) { case 1: int y = 1; g(y); break; default: break; } return 0; }\n', dedent(`
		int f(int x) {
		  auto __disc_5 = x;
		  switch (__disc_5) {
		    case 1: {
		      int y = 1;
		      g(y);
		      break;
		    }
		    default: break;
		  }
		  return 0;
		}
	`));

	// A side-effecting discriminant runs exactly once, into the wrapper every case test reads.
	await check('switch: the discriminant is evaluated once', 'int f() { switch (h()) { case 1: g(); break; } return 0; }\n', dedent(`
		int f() {
		  auto __disc_6 = h();
		  switch (__disc_6) {
		    case 1: g();
		    break;
		  }
		  return 0;
		}
	`));

	// A `break_scope` has no loop's iteration machinery, so a `continue` inside a case is routed past
	// the switch to the enclosing loop -- which still has to run the `for`'s own update.
	await check('switch: continue inside a case reaches the loop update', 'int f(int x) { for (int i = 0; i < 3; i = i + 1) { switch (x) { case 1: continue; default: g(); } } return 0; }\n', dedent(`
		int f(int x) {
		  int i = 0;
		  while (true) {
		    if (!(i < 3)) {
		      break;
		    }
		    auto __disc_12 = x;
		    auto __match0_17 = __disc_12 == 1;
		    switch (__disc_12) {
		      case 1: continue;
		      default: g();
		    }
		    i = i + 1;
		  }
		  return 0;
		}
	`));

	console.log(`--- test-vsdg-cpp: ${failures} failure(s) ---`);
	if (failures)
		process.exitCode = 1;
}

main();
