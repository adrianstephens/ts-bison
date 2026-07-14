import {parse} from '../examples/TS/ts-parser';
import {TSoutput} from '../examples/TS/tocode';
import {TStoDecl, TStypeCheck, TStypeCheckAsync } from '../examples/TS/ts-codegen';

import * as fs from 'fs/promises';
import * as path from 'path';

const output = new TSoutput();
let total_diag = 0;

function test(name: string, code: string, outputCode = false) {
	try {
		console.log('====' + name + '====');
		const ast = parse(code);
		const diag = TStypeCheck(ast);
		if (diag.length) {
			console.error(`Type errors in ${name}:`);
			for (const d of diag)
				console.error(`  ${d.pos.line}:${d.pos.col} - ${d.message}`);
			total_diag += diag.length;
		}
		if (outputCode) {
			//output.toCode(ast);
			//output.toCode(TStoJS(ast)!);
			console.log(output.toCode(TStoDecl(ast)));
		}
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

async function testAsync(name: string, pathname: string, outputCode = false) {
	try {
		console.log('====' + name + '====');
		const {program, diagnostics} = await TStypeCheckAsync(pathname);
		if (diagnostics.length) {
			console.error(`Type errors in ${name}:`);
			for (const d of diagnostics)
				console.error(`  ${d.pos.line}:${d.pos.col} - ${d.message}`);
			total_diag += diagnostics.length;
		}
		if (outputCode) {
			//output.toCode(ast);
			//output.toCode(TStoJS(ast)!);
			console.log(output.toCode(TStoDecl(program)));
		}
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

(async()=> {

await testAsync('source', path.join('/Volumes/DevSSD/dev/packages/vscode-utils/src/fs.ts'));
//await testAsync('source', path.join(__dirname, '../examples/TS/ts-codegen.ts'));

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


//await testAsync('vector', '/Volumes/DevSSD/dev/packages/algebraic/src/index.ts', true);
//await testAsync('source', path.join(__dirname, '../src/tison.ts'));
//await testAsync('vector', '/Volumes/DevSSD/dev/packages/maths/src/vector.ts', true);

async function testDir(dir: string) {
	for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
		if (entry.name === 'node_modules' || entry.name === 'hidden' || entry.name === 'assistant')
			continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory())
			await testDir(full);
		else if (full.endsWith('.ts') && !full.endsWith('.d.ts'))
			await testAsync(full, full);
	}
}

await testDir(path.join(__dirname, '../..'));

console.log('\nAll tests completed!');
console.log(`Total Diagnostics: ${total_diag}`);
})();
