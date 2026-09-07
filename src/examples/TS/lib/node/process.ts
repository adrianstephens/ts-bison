/// <reference path="../lib.d.ts" />

import { proc_exit, args_get, args_sizes_get, environ_get, environ_sizes_get } from 'wasi_snapshot_preview1';

const loadU8	= __asm<[i32], i32>('i32.load8_u');
const loadI32	= __asm<[i32], i32>('i32.load');

export function exit(code: i32): void {
	proc_exit(code);
}

function readCString(ptr: i32): string {
	let len = 0;
	while (loadU8(ptr + len) !== 0)
		len++;
	return String.fromCharCodesAt(ptr, len);
}

// Both `args_get`/`environ_get` share this shape: a sizes call, then a fixed table of pointers into a
// second flat byte buffer, each entry a NUL-terminated string.
function readCStringTable(count: i32, bufPtr: i32): string[] {
	const result: string[] = [];
	for (let i = 0; i < count; i++)
		result.push(readCString(loadI32(bufPtr + i * 4)));
	return result;
}

function loadArgv(): string[] {
	const mark = __allocMark();

	const countPtr = __alloc(4, 4);
	const bufSizePtr = __alloc(4, 4);
	args_sizes_get(countPtr, bufSizePtr);
	const count = loadI32(countPtr);
	const bufSize = loadI32(bufSizePtr);

	const argvPtr = __alloc(count * 4, 4);
	const bufPtr = __alloc(bufSize, 1);
	args_get(argvPtr, bufPtr);

	// `readCStringTable` copies every entry into a GC string before this returns -- safe to release.
	const result = readCStringTable(count, argvPtr);
	__allocRelease(mark);
	return result;
}

// The index-signature type all the way through, not the `Map` this physically builds: that is how
// `process.env` is read (`env.PATH`/`env['PATH']`), and the two are the same value here -- towasm
// routes `{[k: string]: V}` to `Map<string, V>` (see `indexSignatureValueType`). Declaring the two
// sides differently would lean on an assignment real TypeScript rejects, and nothing would catch it:
// `TS/lib/**` is excluded from this project's tsconfig.
// `string | undefined`, matching node's own `ProcessEnv` and the physical truth: a missing key really
// does read back as `undefined`, and declaring it `string` made `process.env.X === undefined` --
// the idiomatic presence test -- fail codegen as "needs a nullable object-typed value".
function loadEnv(): {[key: string]: string | undefined} {
	const mark = __allocMark();

	const countPtr = __alloc(4, 4);
	const bufSizePtr = __alloc(4, 4);
	environ_sizes_get(countPtr, bufSizePtr);
	const count = loadI32(countPtr);
	const bufSize = loadI32(bufSizePtr);

	const environPtr = __alloc(count * 4, 4);
	const bufPtr = __alloc(bufSize, 1);
	environ_get(environPtr, bufPtr);

	const entries = readCStringTable(count, environPtr);
	__allocRelease(mark);

	const result: {[key: string]: string | undefined} = {};
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const eq = entry.indexOf('=');
		if (eq === -1)
			result[entry] = '';
		else
			result[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return result;
}

export const argv: string[] = loadArgv();
export const env: {[key: string]: string | undefined} = loadEnv();
