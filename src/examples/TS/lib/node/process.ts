/// <reference path="../lib.d.ts" />

import { proc_exit, args_get, args_sizes_get, environ_get, environ_sizes_get } from 'wasi_snapshot_preview1';

// Plain functions, not `const x = __asm(...)` -- see the identical note in `lib/node/fs.ts`.
function loadU8(ptr: i32): i32 { return __asm<[i32], i32>('i32.load8_u')(ptr); }
function loadI32(ptr: i32): i32 { return __asm<[i32], i32>('i32.load')(ptr); }

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

function loadEnv(): Map<string, string> {
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

	const result = new Map<string, string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const eq = entry.indexOf('=');
		if (eq === -1)
			result.set(entry, '');
		else
			result.set(entry.slice(0, eq), entry.slice(eq + 1));
	}
	return result;
}

export const argv: string[] = loadArgv();
export const env: Map<string, string> = loadEnv();
