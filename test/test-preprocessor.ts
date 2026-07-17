import {preprocess} from '../examples/CPP/preprocessor';
import {cParser} from '../examples/CPP/c-parser';
import {parse as cppParse} from '../examples/CPP/cpp-parser';

let pass = 0, fail = 0;

// whitespace-insensitive compare: token spacing is irrelevant to the parsers
function eq(name: string, actual: string, expected: string) {
	const strip = (s: string) => s.replace(/\s+/g, '');
	if (strip(actual) === strip(expected)) {
		++pass;
	} else {
		++fail;
		console.error(`FAIL ${name}\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
	}
}

function throws(name: string, fn: () => void, contains?: string) {
	try {
		fn();
		++fail;
		console.error(`FAIL ${name}: did not throw`);
	} catch (e) {
		if (!contains || String(e).includes(contains)) ++pass;
		else { ++fail; console.error(`FAIL ${name}: wrong error:`, e); }
	}
}

// --- macros ---
eq('object',		preprocess('#define N 10\nint a[N];'), 'int a[10];');
eq('func',			preprocess('#define MIN(a,b) ((a)<(b)?(a):(b))\nx = MIN(p, q);'), 'x = ((p)<(q)?(p):(q));');
eq('nested',		preprocess('#define A B\n#define B 42\nint x = A;'), 'int x = 42;');
eq('recursion',		preprocess('#define A B\n#define B A\nint x = A;'), 'int x = A;');
eq('noparen',		preprocess('#define F(x) x\nint F = 3; int y = F(4);'), 'int F = 3; int y = 4;');
eq('empty-macro',	preprocess('#define EMPTY\nint EMPTY x;'), 'int x;');
eq('stringize',		preprocess('#define STR(x) #x\nconst char* s = STR(hello world);'), 'const char* s = "hello world";');
eq('stringize-esc',	preprocess('#define STR(x) #x\nconst char* s = STR("a\\b");'), 'const char* s = "\\"a\\\\b\\"";');
eq('paste',			preprocess('#define GLUE(a,b) a##b\nint GLUE(foo,bar) = 1;'), 'int foobar = 1;');
eq('paste-expand',	preprocess('#define FOOBAR 9\n#define GLUE(a,b) a##b\nint x = GLUE(FOO,BAR);'), 'int x = 9;');
eq('variadic',		preprocess('#define CALL(f, ...) f(__VA_ARGS__)\nCALL(g, 1, 2, 3);'), 'g(1, 2, 3);');
eq('comma-del',		preprocess('#define LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)\nLOG("hi");'), 'printf("hi");');
eq('comma-keep',	preprocess('#define LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)\nLOG("%d", 5);'), 'printf("%d", 5);');
eq('undef',			preprocess('#define X\n#undef X\n#ifdef X\na;\n#endif\nb;'), 'b;');

// --- conditionals ---
eq('if',			preprocess('#if 1\nyes;\n#else\nno;\n#endif'), 'yes;');
eq('if0',			preprocess('#if 0\nyes;\n#else\nno;\n#endif'), 'no;');
eq('ifdef',			preprocess('#define X\n#ifdef X\na;\n#endif\n#ifndef X\nb;\n#endif'), 'a;');
eq('elif',			preprocess('#define V 2\n#if V == 1\na;\n#elif V == 2\nb;\n#elif V == 3\nc;\n#else\nd;\n#endif'), 'b;');
eq('nested-cond',	preprocess('#if 0\n#if 1\na;\n#endif\n#else\nb;\n#endif'), 'b;');
eq('defined',		preprocess('#define X 1\n#if defined(X) && X > 0\na;\n#endif'), 'a;');
eq('defined2',		preprocess('#if defined X || defined Y\na;\n#else\nb;\n#endif'), 'b;');
eq('if0-garbage',	preprocess('#if 0\nthis is $$ not (( C at all\n#endif\nok;'), 'ok;');

// --- #if expressions ---
eq('expr',			preprocess("#if (3*4 >> 2) == 3 && 'A' == 65 && 010 == 8 && 0x10 == 16\nok;\n#endif"), 'ok;');
eq('expr-ternary',	preprocess('#if 1 ? 5 : 0\nok;\n#endif'), 'ok;');
eq('expr-shortckt',	preprocess('#if 0 && 1/0\nbad;\n#else\nok;\n#endif'), 'ok;');
eq('expr-unknown',	preprocess('#if UNKNOWN\nbad;\n#else\nok;\n#endif'), 'ok;');

// --- lines and comments ---
eq('continuation',	preprocess('#define LONG(a) \\\n\t((a) + \\\n\t 1)\nx = LONG(2);'), 'x = ((2) + 1);');
eq('multiline-call', preprocess('#define ADD(a,b) ((a)+(b))\nx = ADD(1,\n        2);'), 'x = ((1)+(2));');
eq('comments',		preprocess('#define X 1 /* comment */ + 2\nint a = X; // trailing'), 'int a = 1 + 2;');
eq('block-comment',	preprocess('int a; /* foo\nbar */ int b;'), 'int a; int b;');
eq('line-file',		preprocess('a = __LINE__;\nb = __FILE__;', {filename: 'f.c'}), 'a = 1; b = "f.c";');
{
	const lines = preprocess('#define X 1\nint a = X;\n#if 0\nskipped\n#endif\nint b;\n').split('\n');
	if (lines.length === 7 && lines[1] === 'int a = 1;' && lines[5] === 'int b;') ++pass;
	else { ++fail; console.error('FAIL line-preserve', JSON.stringify(lines)); }
}

// --- #include ---
eq('include',		preprocess('#include "defs.h"\nint x = VAL;', {include: async name => name === 'defs.h' ? '#define VAL 7\n' : undefined}), 'int x = 7;');
eq('include-skip',	preprocess('#include <vector>\nint x;'), 'int x;');
eq('guard',			preprocess('#include "g.h"\n#include "g.h"\nint x = G;', {include: async () => '#ifndef GH\n#define GH\n#define G 1\n#endif\n'}), 'int x = 1;');

// --- options.defines ---
eq('defines-opt',	preprocess('int x = A + B(2);', {defines: {A: '1', 'B(n)': '((n)*2)'}}), 'int x = 1 + ((2)*2);');

// --- errors ---
throws('error',			() => preprocess('#error nope\n'), 'nope');
eq('error-skipped',	preprocess('#if 0\n#error nope\n#endif\nok;'), 'ok;');
throws('unterminated',	() => preprocess('#if 1\nx;\n'), 'unterminated');
throws('arity',			() => preprocess('#define F(a,b) a+b\nF(1);'), 'expects');

// --- end-to-end through the parsers ---
{
	const ast = cParser.parse(`
#define SIZE 4
#ifdef SIZE
int arr[SIZE];
#else
int arr[1];
#endif
`);
	const decl = JSON.stringify(ast);
	if (decl.includes('"4"') || decl.includes('4')) ++pass;
	else { ++fail; console.error('FAIL c-parser-e2e', decl); }
}
{
	const ast = cppParse(`
#include <vector>
#define T int
std::vector<T> v;
`, {knownTypes: ['std', 'vector']});
	if (JSON.stringify(ast).includes('vector')) ++pass;
	else { ++fail; console.error('FAIL cpp-parser-e2e'); }
}

console.log(`\nPreprocessor tests: ${pass} passed, ${fail} failed`);
if (fail)
	process.exit(1);
