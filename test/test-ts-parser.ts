import * as JSX from '../src/examples/TS/jsx-parser';
import * as TS from '../src/examples/TS/ts-parser';
import * as T from '../src/examples/TS/type-utils';
import * as vsdg from '../src/examples/TS/vsdg';

import { Output} from '../src/examples/TS/tocode';
import { TStoDecl, TStoJS, TStypeCheck, TStypeCheckAsync, loadLib } from '../src/examples/TS/transform';
import { ModuleLoader } from '../src/examples/TS/module-loader';

import * as fs from 'fs/promises';
import * as path from 'path';
import { SEVERITY } from '../src/examples/TS/checker';

const output = new Output();
const total_sev = [] as number[];

const parser = TS.make();
type Parser = typeof parser;
JSX.add();
const parserX = TS.make();

const lib = loadLib(new ModuleLoader(__dirname, {}), ['typescript/lib/lib.es2022.full']);

function test(name: string, code: string, format = 20) {
	try {
		console.log('====' + name + '====');
		const program		= parser.parse(code);
		const diagnostics	= TStypeCheck(program, T.makeGlobal());

		for (const d of diagnostics) {
			total_sev[d.severity] ??= 0;
			++total_sev[d.severity];
		}

		const filtered = diagnostics.filter(d => d.severity > SEVERITY.GAP);
		if (filtered.length) {
			console.error(`Type errors in ${name}:`);
			for (const d of filtered)
				console.error(`  ${d.pos.line}:${d.pos.col} - ${d.message}`);
		}
		switch (format) {
			case 1: console.log(output.module(program)); break;
			case 2: console.log(output.module(TStoJS(program))); break;
			case 3: console.log(output.module(TStoDecl(program))); break;
			case 20: {
				console.log(output.module(program));
				const graph		= vsdg.BuildVSDG(program.body);
				vsdg.Optimize(graph);
				const { blocks, blockIds } = vsdg.applyGlobalCodeMotion(graph);
				const stmts = vsdg.BuildProgram(graph, blocks, blockIds);
				console.log('==== VSDG');
				console.log(output.statements(stmts));
				break;
			}
		}
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

async function testAsync(parser: Parser, name: string, filename: string, format = 0) {
	try {
		console.log('==== ' + name + ' ====');
		const source	= await fs.readFile(filename, 'utf8');
		const loader	= new ModuleLoader(path.dirname(filename), {});
		const program	= parser.parse(source);
		const diags 	= await TStypeCheckAsync(program, loader, await lib);

		for (const d of diags) {
			total_sev[d.severity] ??= 0;
			++total_sev[d.severity];
		}

		const filtered = diags.filter(d => d.severity > SEVERITY.GAP);
		if (filtered.length) {
			console.error(`Type errors in ${name}:`);
			for (const d of filtered)
				console.error(`  ${d.pos.line}:${d.pos.col} - ${d.message}`);
		}
		switch (format) {
			case 1: console.log(output.module(program)); break;
			case 2: console.log(output.module(TStoJS(program))); break;
			case 3: console.log(output.module(TStoDecl(program))); break;
			case 13: {
				const dest = path.join(path.dirname(filename), '../dist', path.basename(filename, '.ts') + '.debug.d.ts');
				await fs.writeFile(dest, output.module(TStoDecl(program)));
				break;
			}
			case 20: {
				console.log(output.module(program));
				const graph		= vsdg.BuildVSDG(program.body);
				vsdg.Optimize(graph);
				const { blocks, blockIds } = vsdg.applyGlobalCodeMotion(graph);
				const stmts = vsdg.BuildProgram(graph, blocks, blockIds);
				//console.log('==== VSDG');
				console.log(output.statements(stmts));
				break;
			}
		}
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

async function testDir(dir: string, ext: string, parser: Parser, format = 0) {
	async function recurse(dir: string) {
		for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
			if (entry.name[0] === '.' || entry.name === 'node_modules' || entry.name === 'hidden' || entry.name === 'assistant')
				continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory())
				await recurse(full);
			else if (full.endsWith(ext) && !full.endsWith('.d.ts'))
				await testAsync(parser, full, full, format);
		}
	}
	await recurse(dir);
}

(async()=> {

await testAsync(parser, 'source', '/Volumes/DevSSD/dev/packages/binary-libs/src/pe.ts', 20);
//await testAsync('source', path.join(__dirname, '../examples/TS/ts-codegen.ts'));

test('typed function', `
function add(a: number, b: number): number {
	return a + b;
}
const f = function(x: number): number { return x * 2; };
`);

test('enum', `
enum Color { Red, Green, Blue }
const enum Direction { Up = 1, Down, Left, Right }
`);

test('typed variables', `
let a: number = 1;
const b: string = "hi";
let c!: boolean;
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

await testDir(path.join(__dirname, '../..'), '.tsx', parserX);
await testDir(path.join(__dirname, '../..'), '.ts', parser);

console.log('\nAll tests completed!');
total_sev.forEach((n, i) => console.log(`${['GAP', 'WARNING', 'ERROR'][i]}: ${n}`));
})();
