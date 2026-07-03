import { parseTS } from './ts-parser';
import { tsToCode } from './ts-codegen';
import * as fs from 'fs/promises';
import * as path from 'path';

async function testDir(dir: string) {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist')
				continue;
			await testDir(full);
		} else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
			const start = Date.now();
			process.stdout.write(full + ' ... ');
			try {
				const code = await fs.readFile(full, 'utf8');
				const ast = parseTS(code);
				tsToCode(ast);
				console.log(`OK (${Date.now() - start}ms)`);
			} catch (e: any) {
				console.log(`FAIL (${Date.now() - start}ms): ${e.message}`);
			}
		}
	}
}
(async () => {
	await testDir(path.join(__dirname, '../..'));
	console.log('DONE');
})();
