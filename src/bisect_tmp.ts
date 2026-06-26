import { parseTS } from './examples/ts-parser';
import * as fs from 'fs';

const full = fs.readFileSync(__dirname + '/tison.ts', 'utf8');
console.error('parsing', full.length, 'chars');
parseTS(full);
console.error('done');
