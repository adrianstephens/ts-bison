import { parse } from '../src/examples/PY/py-parser';

let pass = 0, fail = 0;
const dump = process.argv.includes('-v');

function test(name: string, code: string) {
	try {
		const ast = parse(code);
		console.log(`\u2713 ${name}`);
		if (dump)
			console.log(JSON.stringify(ast, null, 1));
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
def greet(name, greeting="hello", *args, **kwargs) -> str:
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

test('no trailing newline', 'def f():\n    if x:\n        return 1');

test('tab indentation', 'if x:\n\treturn 1\nelse:\n\treturn 2\n');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
