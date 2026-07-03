import {parseTS} from '../examples/ts-parser';
import {tsToCode} from '../examples/ts-codegen';

import * as fs from 'fs/promises';
import * as path from 'path';

function test(name: string, code: string, outputCode = true) {
	try {
		console.log(name);
		const ast = parseTS(code);
		if (outputCode)
			console.log(tsToCode(ast));
		//console.log(JSON.stringify(ast, null, 2));
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

(async()=> {

test('1', `
export type LexCallback = (ctx: LexContext) => Terminal | string | RegExp | undefined
	
export class Terminal<T = string> {
	ignore = false;
	pattern?: RegExp;
	constructor(public name: string, pattern?: RegExp, public lex?: LexCallback) {
		if (pattern)
			this.pattern = new RegExp(pattern.source, 'y' + pattern.flags.replace(/[gyd]/g, ''));
	}
}
`);

test('enum', `
enum Color { Red, Green, Blue }
const enum Direction { Up = 1, Down, Left, Right }
`);


test('type array', `
export function List<T>(single: Rules<T> | (()=>Rules<T>), sep?: string) {
	return Rules<T[]>(self => [
		Rule([single] as const,	$ => [$[0]]),
		sep
			? Rule([self, sep, single] as const,	$ => [...($[0] as T[]), $[2]])
			: Rule([self, single] as const,			$ => [...($[0] as T[]), $[1]])
	]);
}
`);


test('source', await fs.readFile(path.join(__dirname, '../src/tison.ts'), 'utf8'));

async function testDir(dir: string) {
	for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory())
			await testDir(full);
		else if (full.endsWith('.ts') && !full.endsWith('.d.ts'))
			test(full, await fs.readFile(full, 'utf8'), false);
	}
}

await testDir(path.join(__dirname, '../..'));

test('typed variables', `
let a: number = 1;
const b: string = "hi";
let c!: boolean;
`);

test('typed function', `
function add(a: number, b: number): number {
	return a + b;
}
const f = function(x: number): number { return x * 2; };
`);

test('optional & default params', `
function f(a: number, b?: string, c: number = 1) {
	return a;
}
`);

test('type alias', `
type Pair<T> = [T, T];
type Id = string | number;
type Combined = A & B;
`);

test('interface', `
interface Point {
	x: number;
	y: number;
	move?(dx: number, dy: number): void;
	readonly id: string;
}
interface Named extends Point {
	name: string;
}
`);

test('class with generics, implements, typed members', `
interface Shape { area(): number; }
class Box<T> implements Shape {
	public readonly label: string;
	private value: T;
	x?: number;
	constructor(public label: string, value: T) {
		this.label = label;
		this.value = value;
	}
	area(): number {
		return 0;
	}
}
`);

test('as expression / non-null assertion', `
let x = foo as number;
let y = (foo as Bar).baz;
let z = foo!.bar();
let w = (a + b) as number;
`);

test('function types and object types', `
type Callback = (err: Error | null, result?: string) => void;
type Dict = { [key: string]: number };
const handler: Callback = (err, result) => {};
`);

console.log('\nAll tests completed!');
})();
