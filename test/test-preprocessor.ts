import {preprocess} from '../src/examples/CPP/preprocessor';
import {fileResolver} from '../src/examples/CPP/include-resolver';
import {cParser} from '../src/examples/CPP/c-parser';
import {parse as cppParse} from '../src/examples/CPP/cpp-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let pass = 0, fail = 0;

// whitespace-insensitive compare: token spacing is irrelevant to the parsers
async function eq(name: string, actual: string | Promise<string>, expected: string) {
	const strip = (s: string) => s.replace(/\s+/g, '');
	const a = await actual;
	if (strip(a) === strip(expected)) {
		++pass;
	} else {
		++fail;
		console.error(`FAIL ${name}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(expected)}`);
	}
}

async function throws(name: string, fn: () => Promise<unknown>, contains?: string) {
	try {
		await fn();
		++fail;
		console.error(`FAIL ${name}: did not throw`);
	} catch (e) {
		if (!contains || String(e).includes(contains)) {
			++pass;
		} else {
			++fail; console.error(`FAIL ${name}: wrong error:`, e);
		}
	}
}

(async () => {

// --- macros ---
await eq('object',			preprocess('#define N 10\nint a[N];'), 'int a[10];');
await eq('func',			preprocess('#define MIN(a,b) ((a)<(b)?(a):(b))\nx = MIN(p, q);'), 'x = ((p)<(q)?(p):(q));');
await eq('nested',			preprocess('#define A B\n#define B 42\nint x = A;'), 'int x = 42;');
await eq('recursion',		preprocess('#define A B\n#define B A\nint x = A;'), 'int x = A;');
await eq('noparen',			preprocess('#define F(x) x\nint F = 3; int y = F(4);'), 'int F = 3; int y = 4;');
await eq('empty-macro',		preprocess('#define EMPTY\nint EMPTY x;'), 'int x;');
await eq('stringize',		preprocess('#define STR(x) #x\nconst char* s = STR(hello world);'), 'const char* s = "hello world";');
await eq('stringize-esc',	preprocess('#define STR(x) #x\nconst char* s = STR("a\\b");'), 'const char* s = "\\"a\\\\b\\"";');
await eq('paste',			preprocess('#define GLUE(a,b) a##b\nint GLUE(foo,bar) = 1;'), 'int foobar = 1;');
await eq('paste-expand',	preprocess('#define FOOBAR 9\n#define GLUE(a,b) a##b\nint x = GLUE(FOO,BAR);'), 'int x = 9;');
await eq('variadic',		preprocess('#define CALL(f, ...) f(__VA_ARGS__)\nCALL(g, 1, 2, 3);'), 'g(1, 2, 3);');
await eq('comma-del',		preprocess('#define LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)\nLOG("hi");'), 'printf("hi");');
await eq('comma-keep',		preprocess('#define LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)\nLOG("%d", 5);'), 'printf("%d", 5);');
await eq('undef',			preprocess('#define X\n#undef X\n#ifdef X\na;\n#endif\nb;'), 'b;');

// --- conditionals ---
await eq('if',				preprocess('#if 1\nyes;\n#else\nno;\n#endif'), 'yes;');
await eq('if0',				preprocess('#if 0\nyes;\n#else\nno;\n#endif'), 'no;');
await eq('ifdef',			preprocess('#define X\n#ifdef X\na;\n#endif\n#ifndef X\nb;\n#endif'), 'a;');
await eq('elif',			preprocess('#define V 2\n#if V == 1\na;\n#elif V == 2\nb;\n#elif V == 3\nc;\n#else\nd;\n#endif'), 'b;');
await eq('nested-cond',		preprocess('#if 0\n#if 1\na;\n#endif\n#else\nb;\n#endif'), 'b;');
await eq('defined',			preprocess('#define X 1\n#if defined(X) && X > 0\na;\n#endif'), 'a;');
await eq('defined2',		preprocess('#if defined X || defined Y\na;\n#else\nb;\n#endif'), 'b;');
await eq('if0-garbage',		preprocess('#if 0\nthis is $$ not (( C at all\n#endif\nok;'), 'ok;');

// --- #if expressions ---
await eq('expr',			preprocess("#if (3*4 >> 2) == 3 && 'A' == 65 && 010 == 8 && 0x10 == 16\nok;\n#endif"), 'ok;');
await eq('expr-ternary',	preprocess('#if 1 ? 5 : 0\nok;\n#endif'), 'ok;');
await eq('expr-shortckt',	preprocess('#if 0 && 1/0\nbad;\n#else\nok;\n#endif'), 'ok;');
await eq('expr-unknown',	preprocess('#if UNKNOWN\nbad;\n#else\nok;\n#endif'), 'ok;');

// --- lines and comments ---
await eq('continuation',	preprocess('#define LONG(a) \\\n\t((a) + \\\n\t 1)\nx = LONG(2);'), 'x = ((2) + 1);');
await eq('multiline-call',	preprocess('#define ADD(a,b) ((a)+(b))\nx = ADD(1,\n        2);'), 'x = ((1)+(2));');
await eq('comments',		preprocess('#define X 1 /* comment */ + 2\nint a = X; // trailing'), 'int a = 1 + 2;');
await eq('block-comment',	preprocess('int a; /* foo\nbar */ int b;'), 'int a; int b;');
await eq('line-file',		preprocess('a = __LINE__;\nb = __FILE__;', {filename: 'f.c'}), 'a = 1; b = "f.c";');
{
	const lines = (await preprocess('#define X 1\nint a = X;\n#if 0\nskipped\n#endif\nint b;\n')).split('\n');
	if (lines.length === 7 && lines[1] === 'int a = 1;' && lines[5] === 'int b;') {
		++pass;
	} else {
		++fail; console.error('FAIL line-preserve', JSON.stringify(lines));
	}
}

// --- #include ---
await eq('include',			preprocess('#include "defs.h"\nint x = VAL;', {include: async name => name === 'defs.h' ? '#define VAL 7\n' : undefined}), 'int x = 7;');
await eq('include-skip',	preprocess('#include <vector>\nint x;'), 'int x;');
await eq('guard',			preprocess('#include "g.h"\n#include "g.h"\nint x = G;', {include: async () => '#ifndef GH\n#define GH\n#define G 1\n#endif\n'}), 'int x = 1;');

// --- fileResolver: real directory resolution, relative lookup, #pragma once ---
{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-test-'));
	await fs.mkdir(path.join(dir, 'sub'));
	await fs.writeFile(path.join(dir, 'top.h'), '#pragma once\n#define TOP 1\n#include "sub/nested.h"\n');
	await fs.writeFile(path.join(dir, 'sub', 'nested.h'), '#pragma once\n#include "sibling.h"\n#define NESTED 2\n');
	await fs.writeFile(path.join(dir, 'sub', 'sibling.h'), '#pragma once\n#define SIB 3\n');
	const include = fileResolver([dir]);
	await eq('resolver',		preprocess('#include "top.h"\nint x = TOP + NESTED + SIB;', {include, filename: path.join(dir, 'main.cpp')}),
		'int x = 1 + 2 + 3;');
	await eq('pragma-once',		preprocess('#include "top.h"\n#include "top.h"\n#include <top.h>\nint x = TOP;', {include, filename: path.join(dir, 'main.cpp')}),
		'int x = 1;');
	await eq('resolver-miss',	preprocess('#include <no/such/file.h>\nint x;', {include, filename: path.join(dir, 'main.cpp')}), 'int x;');
	await fs.rm(dir, {recursive: true, force: true});
}

// --- options.defines ---
await eq('defines-opt',		preprocess('int x = A + B(2);', {defines: {A: '1', 'B(n)': '((n)*2)'}}), 'int x = 1 + ((2)*2);');

// --- errors ---
await throws('error',			() => preprocess('#error nope\n'), 'nope');
await eq('error-skipped',	preprocess('#if 0\n#error nope\n#endif\nok;'), 'ok;');
await throws('unterminated',	() => preprocess('#if 1\nx;\n'), 'unterminated');
await throws('arity',			() => preprocess('#define F(a,b) a+b\nF(1);'), 'expects');

// --- end-to-end through the parsers ---
{
	const ast = await cParser.parse(`
#define SIZE 4
#ifdef SIZE
int arr[SIZE];
#else
int arr[1];
#endif
`);
	if (JSON.stringify(ast).includes('4')) {
		++pass;
	} else {
		++fail; console.error('FAIL c-parser-e2e', JSON.stringify(ast));
	}
}
{
	const ast = await cppParse(`
#include <vector>
#define T int
std::vector<T> v;
`, {knownTypes: ['std', 'vector']});
	if (JSON.stringify(ast).includes('vector')) {
		++pass;
	} else {
		++fail; console.error('FAIL cpp-parser-e2e');
	}
}

console.log(`\nPreprocessor tests: ${pass} passed, ${fail} failed`);
if (fail)
	process.exit(1);

})();
