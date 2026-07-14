import {parser} from '../examples/TS/js-parser';

function test(name: string, code: string) {
	try {
		console.log(name);
        const ast = parser.parse(code);
		console.log(JSON.stringify(ast, null, 2));
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

console.log('Testing JS Parser...\n');

test('ASI: restricted production (return)', `
function f() {
    return
    1
}
`);

test('ASI: omitted semicolons', `
var a = 1
var b = 2
a + b
`);

test('template literals', `
var a = \`hello \${1+2} goodbye\`;
`);

// The interpolation's own '}' (closing the nested object literal) and the
// template's '}' (closing the interpolation) are different real tokens here
// -- disambiguated entirely by which grammar state the parser is in when
// each is reached, with no explicit brace-depth counter anywhere.
test('template literals: nested braces', `
var a = \`x = \${ {a: 1}.a } end\`;
`);


test('ASI: restricted production (postfix ++)', `
var a = 1
var b = 2
a
++b
`);

test('Regex vs divide', `
var x = a / b
var y = /abc/.test(x)
var z = (1 + 2) / 3
`);

test('binaryChain associativity (3+ same-precedence operands)', `
var a = 1 - 2 - 3;
var b = x && y && z || w;
`);

test('for...of', `
for (const item of items) {
    console.log(item);
}
`);

test('exponentiation (right-associative)', `
var a = 2 ** 3 ** 2;
var b = -2 ** 2;
`);

test('nullish coalescing', `
var a = x ?? y ?? z;
var b = x ?? y ? 1 : 2;
`);

test('object literal shorthand / computed keys', `
var obj = {
    x,
    y,
    foo() { return 1; },
    bar(a, b) { return a + b; },
    [key]: value,
};
`);

test('spread in arrays and calls', `
var a = [1, ...rest, 2];
var b = f(1, ...args, 2);
`);

test('rest parameter', `
function f(a, b, ...rest) {
    return rest;
}
var g = function(...all) {
    return all;
};
var obj = {
    method(...args) { return args; },
};
`);

test('numeric literal upgrades', `
var a = 0b1010;
var b = 0o17;
var c = 1_000_000;
var d = 0x1_FF;
var e = 10n;
var f = 123_456n;
`);

test('tagged templates', `
var a = tag\`hello \${name}\`;
var b = obj.method\`plain text\`;
`);

test('optional chaining', `
var a = obj?.prop;
var b = obj?.[key];
var c = obj?.method();
var d = obj?.a?.b?.c;
`);

test('let and const', `
let a = 1;
const b = 2;
let c, d = 4;
for (let i = 0; i < 5; i++) {
    console.log(i);
}
for (const key in obj) {
    console.log(key);
}
`);

test('Program', `
function fib(n) {
    if (n < 2) {
        return n;
    } else {
        return fib(n - 1) + fib(n - 2);
    }
}

var results = [];
for (var i = 0; i < 5; i++) {
    results.push(fib(i));
}

var obj = {
    name: "test",
    get value() { return 42; },
    items: [1, 2, 3],
};

for (var key in obj) {
    console.log(key);
}
`);

test('default parameters', `
function f(a, b = 1, c = a + b) {
    return a + b + c;
}
var g = function(x = 10) { return x; };
`);

test('object destructuring', `
const {a, b} = obj;
let {x: renamed, y = 1, z: zRenamed = 2} = obj2;
const {p, ...restProps} = obj3;
const {nested: {deep}} = obj4;
`);

test('array destructuring', `
const [a, b] = arr;
let [x, y = 1] = arr2;
const [first, ...rest] = arr3;
const [, , third] = arr4;
const [a2, , c2] = arr5;
`);

test('array holes', `
var a = [1, , 3];
var b = [, , 3];
var c = [1, 2, ,];
var d = [,];
var e = [];
`);

test('destructuring in for-of/for-in', `
for (const {key, value} of entries) {
    console.log(key, value);
}
for (const [k, v] of pairs) {
    console.log(k, v);
}
`);

test('destructuring in function params', `
function f({a, b = 1}, [c, d]) {
    return a + b + c + d;
}
var g = function({x: renamed}) { return renamed; };
`);

test('import declarations', `
import 'side-effect-module';
import defaultExport from 'module1';
import { a, b as renamedB } from 'module2';
import * as ns from 'module3';
import defaultExport2, { c, d } from 'module4';
import defaultExport3, * as ns2 from 'module5';
`);

test('export declarations', `
export { a, b as renamedB };
export { c } from 'module1';
export * from 'module2';
export * as ns from 'module3';
export default 42;
export const x = 1;
export function f() { return 1; }
`);

test('arrow functions: basic forms', `
var a = x => x + 1;
var b = () => 1;
var c = (a, b) => a + b;
var d = (a, b) => { return a + b; };
var e = a => b => a + b;
arr.map(x => x * 2);
`);

test('arrow functions: defaults and rest', `
var a = (x, y = 1) => x + y;
var b = (...args) => args;
var c = (x, y, ...rest) => rest;
`);

test('arrow functions: destructured params', `
var a = ({x, y}) => x + y;
var b = ({x, y = 1}) => x + y;
var c = ([x, y]) => x + y;
var d = ([x, ...rest]) => rest;
var e = ({a: {b}}) => b;
`);

// `=> {}` is always an empty block, never an empty object literal --
// returning an object literal from a concise body needs parens, same as
// real JS, to keep it from being read as the start of a block.
test('arrow functions: block vs object literal body', `
var a = () => {};
var b = () => ({});
var c = () => ({ x: 1 });
`);

test('generators', `
function* gen() {
    yield 1;
    yield;
    yield 1 + 2;
    yield* other();
    var x = yield 1;
}
var g = function*() { yield 1; };
var named = function* inner() { yield 1; };
var obj = { *gen() { yield 1; } };
export function* exported() { yield 1; }
`);

test('yield restricted production (ASI)', `
function* gen() {
    yield
    foo()
}
`);

test('classes: basic', `
class Foo {
    constructor(x) {
        this.x = x;
    }
    bar() {
        return this.x;
    }
}
class Bar extends Foo {
    constructor() {
        super(1);
    }
}
var anon = class { method() { return 1; } };
var named = class Named { method() { return 1; } };
`);

test('classes: members', `
class Foo {
    x = 1;
    y;
    static z = 2;
    get value() { return this.x; }
    set value(v) { this.x = v; }
    static get staticValue() { return 1; }
    *gen() { yield 1; }
    static *staticGen() { yield 1; }
    [computedKey]() { return 1; }
    [computedField] = 1;
}
`);

test('classes: export', `
export class Foo {}
export default class Bar {}
export default class {}
`);

test('async functions', `
async function foo() {
    return await bar();
}
var f = async function() { return await bar(); };
var named = async function inner() { return await bar(); };
async function* gen() { yield await bar(); }
export async function exported() { return await bar(); }
`);

test('async arrow functions', `
var a = async x => await bar(x);
var b = async () => await bar();
var c = async (a, b) => await bar(a, b);
var d = async (...args) => await bar(args);
var e = async (a) => { return await bar(a); };
arr.map(async x => await transform(x));
`);

test('async methods', `
var obj = {
    async foo() { return await bar(); },
    async *gen() { yield await bar(); },
};
class Foo {
    async foo() { return await bar(); }
    async *gen() { yield await bar(); }
    static async staticFoo() { return await bar(); }
}
`);

test('await precedence', `
async function f() {
    return await a + await b;
}
`);

console.log('\nAll tests completed!');
