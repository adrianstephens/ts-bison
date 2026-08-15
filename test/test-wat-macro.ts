import { parseWat, toWasm } from '../src/examples/wat-parser';

function test(name: string, wat: string, check: (mod: ReturnType<typeof parseWat>) => void, defines?: Record<string, string>) {
	console.log(`=== Test: ${name} ===`);
	try {
		const mod = parseWat(wat, defines);
		check(mod);
		console.log(`Successfully parsed and encoded to ${toWasm(mod).toBytes().length} bytes.`);
		console.log('PASSED\n');
	} catch (e) {
		console.error(`FAILED: ${(e as Error).message}\n`);
		if (e instanceof Error && e.stack)
			console.error(e.stack);
		process.exitCode = 1;
	}
}

// A switch's key names a caller-supplied define, not a literal to match against itself -- matched
// here against ctx.defines (passed in as the 4th `test` arg), not anything in the source text.
test('Switch driven by ctx.defines', `
(module
	(func $f (export "f") (result i32)
		(switch $mode
			($debug (i32.const 1))
			($release (i32.const 2))
		)
	)
)
`, (mod: any) => {
	const body = mod.fields.find((f: any) => f.type === 'func').body;
	if (JSON.stringify(body) !== JSON.stringify([{ op: 'i32.const', imm: 2 }]))
		throw new Error(`unexpected expansion: ${JSON.stringify(body)}`);
}, { mode: 'release' });

// A switch arm can declare its own locals, same as a func/macro body -- not just the asm-only $T
// placeholder form (`__towasm_mod`'s own motivating case), a real concretely-typed one too. Resolved
// eagerly here (ctx.defines match), so the local is queued on ctx.pendingLocals immediately, same as
// a macro call's own locals -- and `toWasm` (via the shared `test` helper) proves it actually encodes,
// not just that the AST looks right.
test('Switch arm declares a real local', `
(module
	(func $f (export "f") (result i32)
		(switch $mode
			($debug
				(local $tmp i32)
				(local.set $tmp (i32.const 42))
				(local.get $tmp)
			)
		)
	)
)
`, (mod: any) => {
	const fn = mod.fields.find((f: any) => f.type === 'func');
	if (fn.locals.length !== 1 || fn.locals[0].type !== 'i32')
		throw new Error(`expected one i32 local, got ${JSON.stringify(fn.locals)}`);
}, { mode: 'debug' });

// A switch key can also name one of the *enclosing macro's* own parameters -- unresolvable when the
// macro body itself is parsed (no call site yet), so it's deferred and resolved per call, against
// whatever bare $tag that call passed for the parameter.
test('Switch driven by a macro parameter', `
(module
	(macro $pick (param $which)
		(switch $which
			($a (i32.const 10))
			($b (i32.const 20))
		)
	)
	(func $f (export "f") (result i32) ($pick $a))
	(func $g (export "g") (result i32) ($pick $b))
)
`, (mod: any) => {
	const f = mod.fields.find((x: any) => x.id === '$f').body;
	const g = mod.fields.find((x: any) => x.id === '$g').body;
	if (JSON.stringify(f) !== JSON.stringify([{ op: 'i32.const', imm: 10 }]))
		throw new Error(`unexpected $f expansion: ${JSON.stringify(f)}`);
	if (JSON.stringify(g) !== JSON.stringify([{ op: 'i32.const', imm: 20 }]))
		throw new Error(`unexpected $g expansion: ${JSON.stringify(g)}`);
});

// A switch whose key is neither a ctx.define nor (inside a macro call) bound to a $tag argument
// stays an unresolved placeholder through parsing, and must be rejected at encode time rather than
// silently reaching the binary encoder.
console.log('=== Test: Unresolved switch is rejected at encode time ===');
try {
	const mod = parseWat(`
(module
  (func $f (export "f") (result i32)
    (switch $unset ($a (i32.const 1)))
  )
)
`);
	toWasm(mod);
	console.error('FAILED: expected this to be rejected, but it encoded\n');
	process.exitCode = 1;
} catch (e) {
	console.log(`correctly rejected: ${(e as Error).message}`);
	console.log('PASSED\n');
}


// Simple param substitution, no internal locals.
test('Param substitution', `
(module
  (macro $square (param $x) (i32.mul $x $x))
  (func $f (export "f") (param $n i32) (result i32)
    ($square $n)
  )
)
`, (mod: any) => {
	const body = mod.fields.find((f: any) => f.type === 'func').body;
	if (JSON.stringify(body) !== JSON.stringify([
		{ op: 'local.get', localIndex: '$n' },
		{ op: 'local.get', localIndex: '$n' },
		{ op: 'i32.mul' },
	]))
		throw new Error(`unexpected expansion: ${JSON.stringify(body)}`);
});

// A macro that declares its own local must not collide with itself across two separate call
// sites in the same function -- and, since hoisting goes through ctx.pendingLocals rather than
// grammar-level splicing, this now works nested inside another instruction's operands too.
test('Hygienic locals, nested in an operand position', `
(module
  (macro $double_plus_one (param $x)
    (local $tmp i32)
    (local.set $tmp (i32.add $x $x))
    (i32.add (local.get $tmp) 1)
  )
  (func $f (export "f") (param $a i32) (param $b i32) (result i32)
    (i32.add ($double_plus_one $a) ($double_plus_one $b))
  )
)
`, (mod: any) => {
	const fn = mod.fields.find((f: any) => f.type === 'func');
	if (fn.locals.length !== 2 || new Set(fn.locals.map((l: any) => l.id)).size !== 2)
		throw new Error(`expected 2 distinct hygienic locals, got ${JSON.stringify(fn.locals)}`);
});

// A macro invoking another macro: resolved for free by parse order, since the inner call is
// already expanded by the time the outer macro's own definition reduces.
test('Nested macro calls', `
(module
  (macro $square (param $x) (i32.mul $x $x))
  (macro $sum_of_squares (param $a $b) (i32.add ($square $a) ($square $b)))
  (func $f (export "f") (param $a i32) (param $b i32) (result i32)
    ($sum_of_squares $a $b)
  )
)
`, (mod: any) => {
	const body = mod.fields.find((f: any) => f.type === 'func').body;
	if (JSON.stringify(body) !== JSON.stringify([
		{ op: 'local.get', localIndex: '$a' },
		{ op: 'local.get', localIndex: '$a' },
		{ op: 'i32.mul' },
		{ op: 'local.get', localIndex: '$b' },
		{ op: 'local.get', localIndex: '$b' },
		{ op: 'i32.mul' },
		{ op: 'i32.add' },
	]))
		throw new Error(`unexpected expansion: ${JSON.stringify(body)}`);
});

// Implicit call: `($f arg...)` === `(call $f arg...)`, for any name that isn't a macro.
test('Implicit call', `
(module
  (func $double (param $x i32) (result i32) (i32.mul $x 2))
  (func $f (export "f") (param $n i32) (result i32)
    ($double $n)
  )
)
`, (mod: any) => {
	const body = mod.fields.find((f: any) => f.type === 'func' && f.id === '$f').body;
	if (JSON.stringify(body) !== JSON.stringify([
		{ op: 'local.get', localIndex: '$n' },
		{ op: 'call', funcIndex: '$double' },
	]))
		throw new Error(`unexpected expansion: ${JSON.stringify(body)}`);
});

// A locals-declaring macro used inside a global init expr is a real error (constant exprs can't
// hold locals) rather than something to silently mishandle.
console.log('=== Test: Locals-declaring macro rejected in a global init expr ===');
try {
	parseWat(`
(module
  (macro $with_tmp (param $x) (local $tmp i32) (local.set $tmp $x) (local.get $tmp))
  (global $g i32 ($with_tmp 5))
)
`);
	console.error('FAILED: expected this to be rejected, but it parsed\n');
	process.exitCode = 1;
} catch (e) {
	console.log(`correctly rejected: ${(e as Error).message}`);
	console.log('PASSED\n');
}

// Short-circuiting AND/OR, defined as macros (not built into the parser) using plain WAT control
// flow: `$a` pushes the condition, the flat `if (result i32) ... else ... end` form then only
// evaluates whichever branch is actually taken. This is checked by *running* the compiled wasm
// (via Node's native WebAssembly), not just inspecting the AST -- a side-effecting "bump" func
// standing in for $b proves the untaken branch genuinely never executes, not just that the
// boolean result happens to be right (which a non-short-circuiting i32.and would also get for
// 0/1 inputs).
console.log('=== Test: AND/OR macros genuinely short-circuit (real wasm execution) ===');
try {
	const wat = `
(module
  (macro $AND (param $a $b) $a if (result i32) $b else 0 end)
  (macro $OR  (param $a $b) $a if (result i32) 1 else $b end)

  (global $andCalls (mut i32) (i32.const 0))
  (global $orCalls  (mut i32) (i32.const 0))

  (func $bumpAnd (result i32) (global.set $andCalls (i32.add (global.get $andCalls) 1)) (i32.const 1))
  (func $bumpOr  (result i32) (global.set $orCalls  (i32.add (global.get $orCalls)  1)) (i32.const 1))

  (func $and (export "and") (param $a i32) (result i32) ($AND $a ($bumpAnd)))
  (func $or  (export "or")  (param $a i32) (result i32) ($OR  $a ($bumpOr)))
  (func $andCalls (export "andCalls") (result i32) (global.get $andCalls))
  (func $orCalls  (export "orCalls")  (result i32) (global.get $orCalls))
)
`;
	const bytes = toWasm(parseWat(wat)).toBytes();
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as any));
	const exp = instance.exports as any;

	const checks: [string, number, number][] = [
		['and(0)', exp.and(0), 0],
		['andCalls after and(0)', exp.andCalls(), 0],	// $bumpAnd must NOT have run
		['and(1)', exp.and(1), 1],
		['andCalls after and(1)', exp.andCalls(), 1],
		['or(1)', exp.or(1), 1],
		['orCalls after or(1)', exp.orCalls(), 0],		// $bumpOr must NOT have run
		['or(0)', exp.or(0), 1],
		['orCalls after or(0)', exp.orCalls(), 1],
	];
	for (const [label, actual, expected] of checks) {
		if (actual !== expected)
			throw new Error(`${label} = ${actual}, expected ${expected}`);
		console.log(`${label} = ${actual} (correct)`);
	}
	console.log('PASSED\n');
} catch (e) {
	console.error(`FAILED: ${(e as Error).message}\n`);
	if (e instanceof Error && e.stack)
		console.error(e.stack);
	process.exitCode = 1;
}
