import { parseWat, toWasm } from '../examples/wat-parser';

function test(name: string, run: () => void) {
	console.log(`=== Test: ${name} ===`);
	try {
		run();
		console.log('PASSED\n');
	} catch (e) {
		console.error(`FAILED: ${(e as Error).message}\n`);
		if (e instanceof Error && e.stack)
			console.error(e.stack);
		process.exitCode = 1;
	}
}

function assertEq(actual: unknown, expected: unknown, label: string) {
	if (actual !== expected)
		throw new Error(`${label}: got ${actual}, expected ${expected}`);
}

// Bare literals default to i32.const (int-shaped) / f64.const (float-shaped), and retype to
// match an enclosing folded op's own numeric type.
test('Numeric literal shortcuts retype from context', () => {
	const cases: [string, unknown][] = [
		[`(module (func (result i32) (i32.add 3 4)))`, [{ op: 'i32.const', imm: 3 }, { op: 'i32.const', imm: 4 }, { op: 'i32.add' }]],
		[`(module (func (result f32) (f32.add 3 4)))`, [{ op: 'f32.const', imm: 3 }, { op: 'f32.const', imm: 4 }, { op: 'f32.add' }]],
		[`(module (func (result f64) (f64.add 3.5 1.25)))`, [{ op: 'f64.const', imm: 3.5 }, { op: 'f64.const', imm: 1.25 }, { op: 'f64.add' }]],
	];
	for (const [wat, expected] of cases)
		assertEq(JSON.stringify((parseWat(wat).fields[0] as any).body), JSON.stringify(expected), wat);
});

// A literal beyond Number.MAX_SAFE_INTEGER must stay exact when retyped to i64.const -- the
// shortcut has to hold the original text, not a JS `number` (which would silently round it).
test('Large integer literal retypes to i64 losslessly', () => {
	const body = (parseWat(`(module (func (result i64) (i64.add 9223372036854775807 1)))`).fields[0] as any).body;
	assertEq(body[0].imm, 9223372036854775807n, 'first operand');
	assertEq(body[1].imm, 1n, 'second operand');
});

// A float-shaped literal can't become an exact i32/i64 -- should be a clear parse-time error,
// not silent truncation.
test('Float literal rejected as i32/i64', () => {
	for (const wat of [`(module (func (result i32) (i32.add 3.5 1)))`, `(module (func (result i64) (i64.add 3.5 1)))`]) {
		try {
			parseWat(wat);
			throw new Error(`expected '${wat}' to be rejected`);
		} catch (e) {
			if (!(e as Error).message.includes("can't be used as"))
				throw e;
		}
	}
});

// String literals intern into a deduplicated, NUL-terminated data section and push their byte
// offset. Verified by actually running the compiled wasm and reading the bytes back out of
// linear memory, not just inspecting the AST -- proves the offsets/encoding are really correct,
// not just plausible-looking.
test('String literals intern into a data section (real execution)', () => {
	const wat = `
(module
  (export "memory" (memory 0))
  (func $get1 (export "get1") (result i32) "hello")
  (func $get2 (export "get2") (result i32) "world")
  (func $get3 (export "get3") (result i32) "hello")
)
`;
	const mod = parseWat(wat);
	if (!mod.fields.some((f: any) => f.type === 'memory'))
		throw new Error('expected a memory field to be auto-synthesized');
	assertEq((mod.fields.find((f: any) => f.type === 'data') as any).init, 'hello\0world\0', 'data section content (deduplicated, NUL-terminated)');

	const exp = new WebAssembly.Instance(new WebAssembly.Module(toWasm(mod).toBytes() as any)).exports as any;
	const mem = new Uint8Array(exp.memory.buffer);

	function readCStr(offset: number) {
		let end = offset;
		while (mem[end] !== 0)
			end++;
		return new TextDecoder().decode(mem.slice(offset, end));
	}

	const [o1, o2, o3] = [exp.get1(), exp.get2(), exp.get3()];
	assertEq(readCStr(o1), 'hello', 'get1');
	assertEq(readCStr(o2), 'world', 'get2');
	assertEq(readCStr(o3), 'hello', 'get3');
	assertEq(o1, o3, 'deduplicated: get1 and get3 offsets must match');
});

// A memory the WAT source declares itself must be left alone -- no synthesized second memory.
test('Explicit memory declaration is not duplicated', () => {
	const wat = `
(module
  (memory $mem 2)
  (func (result i32) "hi")
)
`;
	const mod = parseWat(wat);
	const memFields = mod.fields.filter((f: any) => f.type === 'memory');
	assertEq(memFields.length, 1, 'memory field count');
	assertEq((memFields[0] as any).value.min, 2, "kept the source's own memory, not a synthesized one");
});
