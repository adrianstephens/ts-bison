// `lib/lib.d.ts` restates, by hand, members that `lib/*.ts` implements for real. The two are read by
// completely different consumers -- the ambient declarations by `tsc` (under `noLib`, where a primitive's
// member access resolves through `interface String`, not through any class) and the implementations by
// towasm's own `LIB_DECL_MAP` -- so nothing makes them agree.
//
// The dangerous direction is ambient-without-implementation: user code type-checks in the editor and then
// dies in codegen with "unknown method", far from the cause -- verified, not assumed: `'abc'.valueOf()`,
// `u8.map(f)` and `[1,2].toLocaleString()` all check clean and then throw "unknown method". The reverse
// (implemented but not declared) is deliberate in places -- `lib.d.ts` omits plenty on purpose -- so it is
// only reported, never failed on.
//
// Pairs are DISCOVERED, not listed: any name declared ambiently that also has a real class is compared.
// A list would have the same silent-omission failure mode as the lib file list did before it was globbed.
//
// A RATCHET against a baseline, same shape as `test-ts-corpus-gate.ts`: `lib.d.ts` currently declares a
// large aspirational slice of TypeScript's own `TypedArray` that this runtime does not implement, and
// closing all of that is its own project. The baseline records exactly what is outstanding, so no NEW
// drift can appear, and shrinking it is a one-line `--update`.
//
//   npx ts-node -T test/test-lib-decls.ts             # check against the baseline
//   npx ts-node -T test/test-lib-decls.ts --update    # re-baseline after implementing (or removing) some

import fs from 'fs';
import path from 'path';
import * as TS from '../dist/examples/TS/ts-parser';

const LIB_DIR	= path.join(__dirname, '../dist/examples/TS/lib');
// Same glob and the same order towasm.ts itself uses, so this reads exactly the set that gets linked.
const LIB_FILES	= ['lib.d.ts', ...fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.ts') && f !== 'lib.d.ts').sort()];

type Members = { instance: Set<string>; static: Set<string> };
const empty = (): Members => ({ instance: new Set(), static: new Set() });

// A member worth comparing: a real named thing you can write `x.foo` for. An index signature, a call
// signature and a construct signature have no name to match on, and `constructor` is not a member.
function addMembers(into: Set<string>, other: Set<string>, body: any[]) {
	for (const m of body ?? []) {
		if (m.type === 'index' || m.type === 'call' || m.type === 'construct')
			continue;
		if (typeof m.key !== 'string')
			continue;
		// A constructor is not a member, but its PARAMETER PROPERTIES are real fields --
		// `constructor(public source: string)` declares `source` exactly as a field line would, and
		// towasm's own `ensureClass` collects them the same way. Missing this read `Error.message` and
		// `RegExp.source` as unimplemented when both are right there in the signature.
		if (m.key === 'constructor') {
			for (const param of m.params ?? []) {
				if (typeof param.key === 'string' && (param.modifiers ?? []).some((mod: string) => mod === 'public' || mod === 'private' || mod === 'protected'))
					into.add(param.key);
			}
			continue;
		}
		((m.modifiers ?? []).includes('static') ? other : into).add(m.key);
	}
}

const ambient	= new Map<string, Members>();
const real		= new Map<string, Members>();

const slot = (map: Map<string, Members>, name: string) => {
	if (!map.has(name))
		map.set(name, empty());
	return map.get(name)!;
};

for (const file of LIB_FILES) {
	for (const raw of TS.parse(fs.readFileSync(path.join(LIB_DIR, file), 'utf8')).body as any[]) {
		const st = raw.type === 'export_decl' ? raw.declaration : raw;

		if (st.type === 'interface_decl') {
			// An interface's members are all instance-side; `get g(): number` parses as a `property`
			// here and as a `get` on a class, so both normalise to the same name.
			addMembers(slot(ambient, st.name).instance, slot(ambient, st.name).static, st.body);

		} else if (st.type === 'class_decl' && st.name) {
			const target = st.ambient ? slot(ambient, st.name) : slot(real, st.name);
			addMembers(target.instance, target.static, st.body);

		} else if (st.type === 'var_decl' && st.ambient) {
			// `declare var String: { fromCharCode(...): string }` -- the STATIC side of a builtin, which
			// is how `lib.d.ts` has to spell statics for a type whose instance side is an `interface`.
			for (const d of st.declarations ?? []) {
				if (typeof d.name === 'string' && d.typeAnnotation?.type === 'object')
					addMembers(slot(ambient, d.name).static, slot(ambient, d.name).static, d.typeAnnotation.members);
			}
		}
	}
}

const missing: string[] = [];
const compared: string[] = [];
const undeclared: string[] = [];

for (const [name, decl] of [...ambient].sort((a, b) => a[0].localeCompare(b[0]))) {
	const impl = real.get(name);
	// Declared with no implementation at all (`interface Function {}`, `PropertyDescriptor`,
	// `RegExpMatchArray`, ...): a pure type-level shape, nothing to hold it to.
	if (!impl)
		continue;

	for (const [kind, want, have] of [
		['instance', decl.instance, impl.instance],
		['static', decl.static, impl.static],
	] as const) {
		const tag = kind === 'static' ? ' (static)' : '';
		for (const m of [...want].sort()) {
			if (!have.has(m))
				missing.push(`${name}.${m}${tag}`);
		}
		for (const m of [...have].sort()) {
			if (!want.has(m))
				undeclared.push(`${name}.${m}${tag}`);
		}
	}
	compared.push(`${name} (${decl.instance.size + decl.static.size} declared)`);
}
missing.sort();

console.log(`compared ${compared.length} type(s): ${compared.join(', ')}`);
// Informational: `lib.d.ts` deliberately omits plenty (several entries in it are commented out), so this
// is a coverage note, not a defect. It is printed because a name appearing here unexpectedly is the
// cheapest hint that an intended declaration was missed.
if (undeclared.length)
	console.log(`${undeclared.length} implemented but not declared in lib.d.ts (informational): ${undeclared.join(', ')}`);

const BASELINE = path.join(__dirname, 'lib-decls-baseline.json');

if (process.argv.includes('--update')) {
	fs.writeFileSync(BASELINE, JSON.stringify(missing, null, '\t') + '\n');
	console.log(`baseline updated: ${missing.length} declared-but-unimplemented member(s)`);
	process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
	console.log(`no baseline yet -- run with --update to record ${missing.length} declared-but-unimplemented member(s)`);
	process.exit(1);
}

const base		= new Set<string>(JSON.parse(fs.readFileSync(BASELINE, 'utf8')));
const added		= missing.filter(m => !base.has(m));
const fixed		= [...base].filter(m => !missing.includes(m)).sort();

console.log(`lib declarations: ${missing.length} declared-but-unimplemented, baseline ${base.size}`);

if (added.length) {
	for (const m of added)
		console.error(`FAIL - lib.d.ts declares '${m}' but nothing implements it`);
	console.error(`\n${added.length} member(s) newly declared without an implementation.`);
	console.error(`Implement them, drop the declaration, or -- if this is deliberate -- re-baseline with --update.`);
	process.exit(1);
}

if (fixed.length) {
	console.log(`${fixed.length} fewer than baseline (${fixed.join(', ')}) -- commit the improvement with --update.`);
	process.exit(0);
}

console.log('all lib declaration tests passed');
