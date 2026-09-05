/// <reference path="./lib.d.ts" />

import { __alloc } from './console';
import { Map } from './map';
import { proc_exit, args_get, args_sizes_get, environ_get, environ_sizes_get } from 'wasi_snapshot_preview1';

const loadU8	= __asm<[i32], i32>('i32.load8_u');
const loadI32	= __asm<[i32], i32>('i32.load');

export function exit(code: i32): void {
	proc_exit(code);
}

function readCString(ptr: i32): string {
	let result = '';
	let p = ptr;
	let go = true;
	while (go) {
		const c = loadU8(p);
		if (c === 0) {
			go = false;
		} else {
			result = result.concat(String.fromCharCode(c));
			p++;
		}
	}
	return result;
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
	const countPtr = __alloc(4, 4);
	const bufSizePtr = __alloc(4, 4);
	args_sizes_get(countPtr, bufSizePtr);
	const count = loadI32(countPtr);
	const bufSize = loadI32(bufSizePtr);

	const argvPtr = __alloc(count * 4, 4);
	const bufPtr = __alloc(bufSize, 1);
	args_get(argvPtr, bufPtr);
	return readCStringTable(count, argvPtr);
}

function loadEnv(): Map<string, string> {
	const countPtr = __alloc(4, 4);
	const bufSizePtr = __alloc(4, 4);
	environ_sizes_get(countPtr, bufSizePtr);
	const count = loadI32(countPtr);
	const bufSize = loadI32(bufSizePtr);

	const environPtr = __alloc(count * 4, 4);
	const bufPtr = __alloc(bufSize, 1);
	environ_get(environPtr, bufPtr);

	const entries = readCStringTable(count, environPtr);
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
