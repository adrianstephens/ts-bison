// Compiles C++ with the partial back end, then RUNS the wasm and checks the answers -- the point being
// that the physical half comes from `wasm-codegen.ts`, which was written for TypeScript.
import * as CPP from '../dist/examples/CPP/cpp-parser';
import { CPPtoWasm } from '../dist/examples/CPP/backend';
import * as W from '../dist/examples/wasm-codegen';

const SOURCE = `
int gcd(int a, int b) {
    while (b != 0) {
        int t = b;
        b = a % b;
        a = t;
    }
    return a;
}

int fib(int n) {
    if (n < 2)
        return n;
    return fib(n - 1) + fib(n - 2);
}

double average(int count) {
    double total = 0;
    int i = 0;
    while (i < count) {
        total = total + i;
        i = i + 1;
    }
    return count == 0 ? 0 : total / count;
}

int clamp(int x, int lo, int hi) {
    return x < lo ? lo : (x > hi ? hi : x);
}

int countdown(int n) {
    int steps = 0;
    while (1) {
        if (n <= 0)
            break;
        n = n - 1;
        steps = steps + 1;
    }
    return steps;
}

long scale(int n) {
    long acc = 0;
    int i = 0;
    while (i < n) {
        acc = acc + 1000000000;
        i = i + 1;
    }
    return acc;
}

int negate(int x) { return -x; }
int isZero(int x) { return !x; }
`;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = got === want;
	if (!ok)
		++failures;
	console.log(`${ok ? 'ok  ' : 'FAIL'} - ${label} = ${got}${ok ? '' : ` (expected ${want})`}`);
}

// A construct outside the documented scope must throw, not miscompile.
async function checkRejects(label: string, src: string) {
	try {
		CPPtoWasm(await CPP.parse(src, { filename: 'reject.cpp' }));
	} catch (e) {
		console.log(`ok   - rejects ${label}: ${e instanceof W.Error ? e.msg : e}`);
		return;
	}
	++failures;
	console.log(`FAIL - ${label} was accepted, but is out of scope`);
}

async function main() {
	const mod	= CPPtoWasm(await CPP.parse(SOURCE, { filename: 'suite.cpp' }));
	const bytes	= mod.toBytes();
	const e		= (await WebAssembly.instantiate(bytes as BufferSource, {})).instance.exports as Record<string, CallableFunction>;

	check('gcd(1071, 462)',		e.gcd(1071, 462),	21);
	check('gcd(17, 5)',			e.gcd(17, 5),		1);
	check('fib(10)',			e.fib(10),			55);
	check('fib(20)',			e.fib(20),			6765);
	check('average(5)',			e.average(5),		2);
	check('average(0)',			e.average(0),		0);
	check('clamp(42, 0, 10)',	e.clamp(42, 0, 10),	10);
	check('clamp(-3, 0, 10)',	e.clamp(-3, 0, 10),	0);
	check('clamp(7, 0, 10)',	e.clamp(7, 0, 10),	7);
	check('countdown(5)',		e.countdown(5),		5);
	check('negate(7)',			e.negate(7),		-7);
	check('isZero(0)',			e.isZero(0),		1);
	check('isZero(3)',			e.isZero(3),		0);
	// i64 accumulation past 2^31, which an i32 slot would have wrapped.
	check('scale(4)',			e.scale(4),			4000000000n);

	await checkRejects('a pointer',		'int f(int *p) { return 0; }');
	await checkRejects('a class',		'struct S { int x; }; int f() { S s; return 0; }');
	await checkRejects('an unknown call','int f() { return nope(1); }');

	console.log(failures ? `\n${failures} failure(s)` : '\nall cpp back end tests passed');
	process.exit(failures ? 1 : 0);
}

main();
