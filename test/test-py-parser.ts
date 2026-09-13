import { parse, Expr, Stmt } from '../src/examples/PY/py-parser';
import { Output } from '../src/examples/PY/tocode';
import { walk, walkB } from '../src/examples/PY/walker';

let pass = 0, fail = 0;
const dump = process.argv.includes('-v');
const out = new Output();

function test(name: string, code: string) {
	try {
		const ast = parse(code);
		const printed = out.module(ast);

		// tocode round-trip: print -> parse -> print, the second printing must be identical.
		const printed2 = out.module(parse(printed));

		// walk() identity transform + walkB() full traversal: rebuilding every visited node must
		// leave a tree that prints the same, and walkB must reach every node it structurally can.
		let visited = 0;
		const rebuilt = walk((s, p) => p(s) as Stmt, (e, p) => p(e) as Expr).module(ast);
		walkB(s => (visited++, false), e => (visited++, false)).statements(ast.body);

		if (dump) {
			console.log(`\u2713 ${name}`);
			console.log('--- tocode ---\n' + printed);
		}
		if (printed !== printed2)
			throw new Error(`tocode not stable\n--- 1 ---\n${printed}\n--- 2 ---\n${printed2}`);
		if (out.module(rebuilt) !== printed)
			throw new Error(`walk() identity changed the tree\n${out.module(rebuilt)}`);
		if (visited === 0)
			throw new Error('walkB visited nothing');
		console.log(`\u2713 ${name}`);
		pass++;
	} catch (e) {
		console.error(`\u2717 ${name}:`, (e as Error).message);
		fail++;
	}
}

console.log('Testing Python Parser...\n');

test('simple assignments', `
x = 1
y, z = 2, 3
a = b = c = 0
x += 1
n: int = 5
`);

test('function def', `
def greet(name: str, greeting="hello", *args: int, **kwargs: str) -> str:
    return greeting + ", " + name
`);

test('if / elif / else', `
if x > 0:
    print("pos")
elif x < 0:
    print("neg")
else:
    print("zero")
`);

test('nested blocks and dedent to zero', `
def f():
    if a:
        if b:
            return 1
    return 2
c = 3
`);

test('multi-level dedent onto elif attaches to the outer if', `
if a:
    if b:
        x
elif c:
    y
`);

test('for / while / comprehensions', `
for i in range(10):
    total += i
squares = [n*n for n in nums if n % 2 == 0]
pairs = {k: v for k, v in items}
matrix = [x for row in m for x in row]
g = (x for x in xs)
`);

test('classes and decorators', `
@decorator
@mod.deco(arg)[0]
class Foo(Base, metaclass=Meta):
    """docstring"""
    x: int = 0

    def method(self):
        return self.x
`);

test('try / except / finally', `
try:
    risky()
except ValueError as e:
    handle(e)
except (TypeError, KeyError):
    other()
except* OSError:
    grouped()
else:
    ok()
finally:
    cleanup()
`);

test('with statement', `
with open("f") as fh, lock:
    data = fh.read()
with a as b, c as d:
    pass
with (
    first() as x,
    second() as y,
):
    pass
`);

test('expressions and precedence', `
r = a + b * c - d / e
s = not a and b or c
t = a < b <= c == d
u = lambda x, y=1: x + y
v = a if cond else b
w = obj.attr[1:2].method(x, *rest, **kw)
p = 2 ** 3 ** 2
q = -2 ** 2
walrus = [y for x in data if (y := f(x)) is not None]
`);

test('literals: shared common.ts leaf shapes', `
flag = True or False or None
count = 0xFF_00 + 1_000_000 + 0o17 + 0b1010
ratio = 3.14e-2
imag = 2j
text = "adjacent" " strings" ' concat'
huge = 123456789012345678901234567890
`);

test('imports', `
import os
import os.path as p
from . import thing
from ..pkg.mod import (a, b as c,)
from mod import *
`);

test('async', `
async def main():
    async with session() as s:
        async for row in s:
            await process(row)
    return [x async for x in gen()]
`);

test('line continuation and brackets', `
x = (1 +
     2 +
     3)
y = 1 + \\
    2
`);

test('match / case / type are ordinary identifiers', `
match = re.match(pat, s)
case = 1
type = str
`);

test('slices, del, global, assert, raise from', `
del a[0], b.c
global g1, g2
assert x == y, "mismatch"
raise RuntimeError("x") from err
s = data[::2, 1:]
`);

test('f-strings: fields, conv, spec, nested spec, self-doc, all quote styles', `
a = f"hi {name}"
b = f'{val!r}'
c = f"{val:.2f}"
d = f"{val:>{width}}"
e = f"{val=}"
g = f"{{literal}} {val}"
h = f"""multi
line {x}
end"""
i = f'''also {y} works'''
j = rf"C:\\path\\{drive}"
`);

test('no trailing newline', 'def f():\n    if x:\n        return 1');

test('tab indentation', 'if x:\n\treturn 1\nelse:\n\treturn 2\n');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
