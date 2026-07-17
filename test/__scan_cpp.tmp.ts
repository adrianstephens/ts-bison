import {parse} from '../examples/CPP/cpp-parser';
import * as fs from 'fs/promises';
import * as path from 'path';

// harvest type names from headers (regex approximation of what #include would register)
const knownTypes = new Set<string>(['FILE', 'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
	'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'va_list', 'time_t']);

async function harvest(dir: string) {
	for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await harvest(full);
		else if (/\.(h|hpp|ipp)$/.test(entry.name)) {
			// strip comments AND template parameter lists (else `template<class B>` registers 'B' globally)
			const src = (await fs.readFile(full, 'utf8')).replace(/\/\/[^\n]*|\/\*[^]*?\*\//g, ' ').replace(/template\s*<[^<>]*>/g, ' ');
			for (const m of src.matchAll(/\b(?:class|struct|union|enum)\s+([A-Za-z_]\w*)/g)) knownTypes.add(m[1]);
			for (const m of src.matchAll(/\btypedef\b[^;{}()]*?([A-Za-z_]\w*)\s*;/g)) knownTypes.add(m[1]);
			for (const m of src.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=/g)) knownTypes.add(m[1]);
			for (const m of src.matchAll(/\bnamespace\s+([A-Za-z_]\w*)/g)) knownTypes.add(m[1]);
		}
	}
}

interface Fail { file: string; line: number; col: number; msg: string; src: string; }
const fails: Fail[] = [];
let pass = 0, total = 0;

async function scan(dir: string) {
	for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await scan(full);
		else if (full.endsWith('.cpp')) {
			const code = await fs.readFile(full, 'utf8');
			++total;
			try {
				parse(code, {knownTypes});
				++pass;
			} catch (e: any) {
				const msg: string = e.message ?? String(e);
				const m = /line (\d+), col (\d+)/.exec(msg);
				const line = m ? +m[1] : 0, col = m ? +m[2] : 0;
				const src = line ? (code.split('\n')[line - 1] ?? '').trim() : '';
				fails.push({file: full, line, col, msg: msg.split('. Expected')[0].split('\n')[0], src});
			}
		}
	}
}

(async () => {
	const root = process.argv[2] ?? '/Volumes/DevSSD/dev/shared';
	await harvest(root);
	console.log(`${knownTypes.size} harvested type names`);
	await scan(root);
	console.log(`${pass}/${total} parsed`);
	const groups = new Map<string, Fail[]>();
	for (const f of fails) {
		const key = /Unexpected token '([^']*)'/.exec(f.msg)?.[1] ?? f.msg.replace(/line \d+, col \d+/, '').slice(0, 60);
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
	}
	for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`\n=== ${key}  (${g.length} files) ===`);
		for (const f of g.slice(0, 5))
			console.log(`  ${f.file}:${f.line}:${f.col}\n    ${f.src.slice(0, 130)}`);
	}
})();
