/// <reference path="../lib.d.ts" />

import {
	fd_write, fd_read, fd_close, fd_filestat_get,
	fd_prestat_get, fd_prestat_dir_name,
	path_open, path_create_directory,
} from 'wasi_snapshot_preview1';

// No `heap` save/restore here (unlike console.ts's `__writeString`): `heap` is private to console.ts,
// only `__alloc` is exported, so every scratch buffer allocated below is permanent bump-allocator waste.
// Fine for a bump allocator with no free -- just not reclaimed, same tradeoff `__alloc` itself already has.

const loadU8	= __asm<[i32], i32>('i32.load8_u');
const loadI32	= __asm<[i32], i32>('i32.load');
const storeU8	= __asm<[i32, i32], void>('i32.store8');
const storeI32	= __asm<[i32, i32], void>('i32.store');

function writeBytes(s: string): i32 {
	const len = s.length;
	const buf = __alloc(len, 1);
	for (let i = 0; i < len; i++)
		storeU8(buf + i, s.charCodeAt(i));
	return buf;
}

function readBytes(ptr: i32, len: i32): string {
	let result = '';
	for (let i = 0; i < len; i++)
		result = result.concat(String.fromCharCode(loadU8(ptr + i)));
	return result;
}

class Preopen {
	fd: i32;
	rel: string;
	constructor(fd: i32, rel: string) {
		this.fd = fd;
		this.rel = rel;
	}
}

// WASI paths resolve relative to a preopened directory fd, not a global filesystem root -- scans the
// preopen table (fd 3 upward, per the WASI convention) for the longest preopened name that prefixes
// `p`, the same "longest matching preopen" rule wasi-libc's own path resolution uses.
function findPreopen(p: string): Preopen {
	const prestatBuf = __alloc(8, 4);
	let fd = 3;
	let bestFd = -1;
	let bestName = '';
	let go = true;
	while (go) {
		if (fd_prestat_get(fd, prestatBuf) !== 0) {
			go = false;
		} else {
			if (loadU8(prestatBuf) === 0) {
				const nameLen = loadI32(prestatBuf + 4);
				const nameBuf = __alloc(nameLen, 1);
				fd_prestat_dir_name(fd, nameBuf, nameLen);
				const name = readBytes(nameBuf, nameLen);
				const matches = name === '.' || p === name || p.slice(0, name.length + 1) === name + '/';
				if (matches && name.length >= bestName.length) {
					bestFd = fd;
					bestName = name;
				}
			}
			fd++;
		}
	}
	if (bestFd === -1)
		return new Preopen(3, p);
	if (bestName === '.') {
		const rel = p.charCodeAt(0) === 47 ? p.slice(1) : p;
		return new Preopen(bestFd, rel.length === 0 ? '.' : rel);
	}
	let rel = p.slice(bestName.length);
	if (rel.charCodeAt(0) === 47)
		rel = rel.slice(1);
	return new Preopen(bestFd, rel.length === 0 ? '.' : rel);
}

// `encoding` is accepted for signature compatibility but ignored: every string in this runtime is the
// same byte-per-codeunit representation `console.ts` documents, so there's no second encoding to pick.
export function readFileSync(p: string, encoding: string): string {
	const pre = findPreopen(p);
	const pathBuf = writeBytes(pre.rel);

	const fdOut = __alloc(4, 4);
	// dirflags=1 (follow symlinks); rights fields are all-ones -- this toy WASI layer never narrows
	// per-call capabilities, it just asks for everything.
	path_open(pre.fd, 1, pathBuf, pre.rel.length, 0, -1, -1, 0, fdOut);
	const fileFd = loadI32(fdOut);

	const statBuf = __alloc(64, 8);
	fd_filestat_get(fileFd, statBuf);
	// filestat.size is a 64-bit field at byte offset 32; wasm is little-endian, so a plain i32.load
	// there reads its low 32 bits, which is exactly the file's size for anything under 4GiB.
	const size = loadI32(statBuf + 32);

	const dataBuf = __alloc(size, 1);
	const iov = __alloc(8, 4);
	storeI32(iov, dataBuf);
	storeI32(iov + 4, size);
	const nreadPtr = __alloc(4, 4);
	fd_read(fileFd, iov, 1, nreadPtr);
	fd_close(fileFd);

	return readBytes(dataBuf, size);
}

export function writeFileSync(p: string, data: string): void {
	const pre = findPreopen(p);
	const pathBuf = writeBytes(pre.rel);

	const fdOut = __alloc(4, 4);
	// oflags 9 = CREAT (1) | TRUNC (8): create the file if missing, replace its contents if present.
	path_open(pre.fd, 1, pathBuf, pre.rel.length, 9, -1, -1, 0, fdOut);
	const fileFd = loadI32(fdOut);

	const dataBuf = writeBytes(data);
	const iov = __alloc(8, 4);
	storeI32(iov, dataBuf);
	storeI32(iov + 4, data.length);
	const nwrittenPtr = __alloc(4, 4);
	fd_write(fileFd, iov, 1, nwrittenPtr);
	fd_close(fileFd);
}

export function mkdirSync(p: string): void {
	const pre = findPreopen(p);
	const pathBuf = writeBytes(pre.rel);
	path_create_directory(pre.fd, pathBuf, pre.rel.length);
}
