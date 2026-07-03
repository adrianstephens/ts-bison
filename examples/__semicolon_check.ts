import { jsParser } from './js-parser';
import { parseTS } from './ts-parser';
import * as fs from 'fs';

const cases = [
	'class C { foo() {}; bar() {} }',
	'class C { ; foo() {} ; }',
	'class C { ;;; }',
];
for (const c of cases) {
	try {
		console.log(c, '=>', JSON.stringify(jsParser.parse(c)));
	} catch (e) {
		console.log(c, '=> FAILED:', (e as Error).message.split('\n')[0]);
	}
}

const src = fs.readFileSync('/Volumes/DevSSD/dev/packages/binary/src/async.ts', 'utf8');
try {
	parseTS(src);
	console.log('async.ts: PASSED');
} catch (e) {
	console.log('async.ts: FAILED:', (e as Error).message.split('\n')[0]);
}
