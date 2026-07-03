import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const args = process.argv.slice(2);
const maxN = parseInt((args.find(a => /^--max=\d+$/.test(a)) || '--max=24').split('=')[1], 10) || 24;
const targetFile = resolve(args.find(a => a.startsWith('--target='))?.split('=')[1] ?? './src/tison.ts');

function generateOverloads(maxN: number): string {
	const lines: string[] = [];

	for (let n = 1; n <= maxN; n++) {
		const typeParams = ['T', 'C'];
		const paramParts: string[] = [];

		for (let i = 1; i <= n; i++) {
			typeParams.push(`S${i}`);
		}

		for (let i = 1; i <= n; i++) {
			if (i === 1) {
				paramParts.push(`s1: RSymR<T, [], C>`);
			} else {
				const prevTypes = Array.from({ length: i - 1 }, (_, k) => `S${k + 1}`).join(', ');
				paramParts.push(
					`s${i} extends SymR<[${prevTypes}], C>, s${i}: RSymR<T, [${prevTypes}], C>`
				);
			}
		}

		const params = paramParts.join(', ');
		lines.push(`export function RuleR<${typeParams.join(', ')}>(${params}): Rule<T>;`);
	}

	return lines.join('\n');
}

const overloadCode = generateOverloads(maxN);

let content = readFileSync(targetFile, 'utf-8');

// Find where existing overloads end (just before the impl signature)
const implStartMarker = 'export function RuleR(...syms: any[]): any';
const implIdx = content.indexOf(implStartMarker);
if (implIdx === -1) {
	console.error('Could not find implementation signature in target file');
	process.exit(1);
}

// Find the first existing overload line before impl
let insertPos = implIdx;
while (insertPos > 0 && content[insertPos - 1] !== '\n') insertPos--;
const firstOverloadIdx = content.lastIndexOf('export function RuleR<', insertPos);

if (firstOverloadIdx !== -1) {
	// Remove old overloads
	content = content.slice(0, firstOverloadIdx) + content.slice(insertPos);
}

const newBefore = content;
const output = newBefore + '\n' + overloadCode + '\n\n' + content.slice(content.indexOf('export function RuleR(', content.indexOf('\n', insertPos)));

// Actually just replace the block
const beforeImplIdx = content.indexOf(implStartMarker);
const firstOverloadInContent = content.indexOf('export function RuleR<');

if (firstOverloadInContent !== -1 && firstOverloadInContent < beforeImplIdx) {
	content = content.slice(0, firstOverloadInContent) + content.slice(beforeImplIdx);
}

writeFileSync(targetFile, content);
console.log(`Generated ${maxN} RuleR overloads into ${targetFile}`);
