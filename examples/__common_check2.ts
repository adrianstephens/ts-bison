import { parseTS } from './ts-parser';
import * as fs from 'fs';

const src = fs.readFileSync('/Volumes/DevSSD/dev/packages/binary/src/common.ts', 'utf8');
try {
	parseTS(src);
	console.log('common.ts: PASSED');
} catch (e) {
	console.log('common.ts: FAILED:', (e as Error).message.split('\n')[0]);
}
