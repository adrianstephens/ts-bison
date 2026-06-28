import {cParser} from '../examples/c-parser';

function test(name: string, code: string) {
	try {
		console.log(name);
		console.log(JSON.stringify(cParser.parse(code), null, 2));
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}


// --- Test the parser ---
console.log('Testing C Parser...\n');

test('ambiguous',`
typedef int foo;
foo * bar;   // declaration of bar as pointer-to-foo or multiplication of foo and bar?
`);

// Test 1: Simple function definition
test('Function Definition', `
int main() {
	return 0;
}
`);

// Test 2: Expression parsing
test('Complex Expression', `
int foo(int a, int b) {
	return a + b * c;
}
`);


// Test 3: If-else statement
test('If else',`
int bar(int x) {
	if (x > 0) {
		return 1;
	} else {
		return -1;
	}
}
`);

// Test 4: Struct definition
test('Struct',`
struct Point {
	int x;
	float y;
};
`);

// Test 5: For loop
test('For', `
int sum(int n) {
	int total = 0;
	for (int i = 0; i < n; i++) {
		total += i;
	}
	return total;
}
`);

// Test 6: chained assignment -- must parse as a = (b = c), not (a = b) = c
test('Chained assignment', `
int main() {
	int a, b, c;
	a = b = c;
}
`);

test('Bitwise and shift operators', `
int f() {
	return (a & b) | (c ^ d) | (a << 2) | (b >> 1);
}
`);

test('Ternary conditional (right-associative)', `
int f() {
	return a ? b : c ? d : e;
}
`);

// The comma operator only applies inside parens/subscripts -- it must not
// be confused with the unrelated commas separating arguments, declarators,
// or initializer-list elements.
test('Comma operator vs. comma-as-separator', `
int f() {
	int a = 1, b = 2, c = 3;
	g(a, b, c);
	return (a, b);
}
`);

test('sizeof', `
int f() {
	return sizeof a + sizeof(int) + sizeof(int *);
}
`);

test('Pointer cast', `
int f() {
	return (int *)x;
}
`);

test('Remaining compound assignment operators', `
int f() {
	a %= 2;
	a &= 1;
	a |= 1;
	a ^= 1;
	a <<= 1;
	a >>= 1;
}
`);

// `(*fp)` is what lets the pointer bind to the *name* fp rather than to the
// function type -- "fp is a pointer to a function", not "a function
// returning a pointer". `int *x` as a parameter is new too: parameter
// declarators previously couldn't have a pointer at all.
test('Function pointer declarator and pointer parameters', `
int (*fp)(int, int);
void f(int *x) {
	*x = 1;
	fp = g;
}
`);

test('do...while', `
int f() {
	int i = 0;
	do {
		i++;
	} while (i < 10);
	return i;
}
`);

test('goto and labeled statement', `
int f() {
	goto end;
	end:
	return 0;
}
`);

test('auto and register storage classes', `
void f() {
	auto int a;
	register int b;
}
`);

test('Brace initializer lists (incl. nested, and for structs)', `
int arr[3] = {1, 2, 3};
int matrix[2][2] = {{1, 2}, {3, 4}};
struct Point {
	int x;
	int y;
} p = {1, 2};
`);

test('Struct/union/enum tag-only references', `
struct Point p;
union Value v;
enum Color c;
struct Point getOrigin(struct Point p);
`);

test('Empty array brackets', `
int arr[];
void f(int params[]) {
	return;
}
`);

// Abstract declarators (no name anywhere) for casts/sizeof -- arrays,
// functions, and pointer combinations, not just a bare pointer.
test('Abstract declarators in sizeof/casts', `
int f() {
	int a = sizeof(int[5]);
	int b = sizeof(int[]);
	int c = sizeof(int (*)(int));
	int d = sizeof(int(void));
	int e = sizeof(int (*)[5]);
	int g = sizeof(int *[5]);
	int h = sizeof(int **);
	int i = sizeof(struct Point);
	return ((int (*)(int))fp)(5) + (int *)x;
}
`);

console.log('\nAll tests completed!');
