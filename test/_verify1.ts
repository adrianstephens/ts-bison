import { jsParser } from '../examples/js-parser';
const cases = [
	'async();',
	'let x = async;',
	'async.foo();',
	'async function f() {}',
	'const f = async () => {};',
	'class C { async() {} }',
	'get();',
	'({ get: 5 });',
];
for (const c of cases) {
	try {
		console.log(c, '=>', JSON.stringify(jsParser.parse(c)));
	} catch (e) {
		console.log(c, '=> FAILED:', (e as Error).message.split('\n')[0]);
	}
}
