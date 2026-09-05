/// <reference path="../lib.d.ts" />

import {
	fd_write, fd_read, fd_close, fd_filestat_get,
	fd_prestat_get, fd_prestat_dir_name,
	path_open, path_create_directory,
} from 'wasi_snapshot_preview1';

// Plain functions wrapping an inline `__asm(...)(...)` call, not `const x = __asm(...)` -- towasm.ts's
// asm-builtin binding only resolves that shorthand for a name declared in the always-loaded static lib
// files, never an on-demand module like this one; a real function body containing the same inline call
// compiles fine everywhere. (Confirmed via `WebAssembly.validate`, not difftest -- see report.)
function loadU8(ptr: i32): i32 { return __asm<[i32], i32>('i32.load8_u')(ptr); }
function loadI32(ptr: i32): i32 { return __asm<[i32], i32>('i32.load')(ptr); }
function storeU8(ptr: i32, v: i32): void { __asm<[i32, i32], void>('i32.store8')(ptr, v); }
function storeI32(ptr: i32, v: i32): void { __asm<[i32, i32], void>('i32.store')(ptr, v); }

// WASI rights are a capability mask, and `path_open` REFUSES (errno 76, ENOTCAPABLE) any right the parent
// directory fd does not itself hold -- asking for all-ones fails against every real host. Ask for exactly
// what each call uses: fd_read(1<<1) | fd_seek(1<<2) | fd_tell(1<<5) | fd_filestat_get(1<<21), and the
// same with fd_write(1<<6) in place of fd_read.
// Written as literals, not named consts: a module-level scalar `const` in an ON-DEMAND module has no
// module-scoped global to live in (only functions are seeded across modules), so naming them here makes
// the whole file miscompile -- the same limitation that stops `const f = __asm<...>(...)` binding.
function rightsRead(): i64	{ return 2097190; }
function rightsWrite(): i64	{ return 2097252; }

// There is no exception mechanism to raise yet, and CONTINUING is worse than stopping: an ignored errno
// leaves the out-pointer unwritten, so the next step reads whatever was in that scratch as a descriptor or
// a length. That is how a failed open became a multi-hundred-megabyte allocation, and then a hang.
function wasiCheck(errno: i32): void {
	if (errno !== 0)
		__asm<[], void>('unreachable')();
}

function writeBytes(s: string): i32 {
	const len = s.length;
	const buf = __alloc(len, 1);
	for (let i = 0; i < len; i++)
		storeU8(buf + i, s.charCodeAt(i));
	return buf;
}

function readBytes(ptr: i32, len: i32): string {
	return String.fromCharCodesAt(ptr, len);
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
	const mark = __allocMark();
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
				// Nested mark: `nameBuf`'s size varies per fd, so it's released as soon as its one use
				// (`readBytes`, which copies it into a GC string) is done, not held for the whole scan.
				const nameMark = __allocMark();
				const nameBuf = __alloc(nameLen, 1);
				fd_prestat_dir_name(fd, nameBuf, nameLen);
				const name = readBytes(nameBuf, nameLen);
				__allocRelease(nameMark);
				const matches = name === '.' || p === name || p.slice(0, name.length + 1) === name + '/';
				if (matches && name.length >= bestName.length) {
					bestFd = fd;
					bestName = name;
				}
			}
			fd++;
		}
	}
	// Safe here: everything that survives the scan (`bestFd`, `bestName`) is either a plain fd number
	// or a GC string, never a pointer into `prestatBuf`.
	__allocRelease(mark);

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
	const mark = __allocMark();

	const pathBuf = writeBytes(pre.rel);

	const fdOut = __alloc(4, 4);
	// dirflags=1 (follow symlinks).
	wasiCheck(path_open(pre.fd, 1, pathBuf, pre.rel.length, 0, rightsRead(), rightsRead(), 0, fdOut));
	const fileFd = loadI32(fdOut);

	const statBuf = __alloc(64, 8);
	wasiCheck(fd_filestat_get(fileFd, statBuf));
	// filestat.size is a 64-bit field at byte offset 32; wasm is little-endian, so a plain i32.load
	// there reads its low 32 bits, which is exactly the file's size for anything under 4GiB.
	const size = loadI32(statBuf + 32);

	const dataBuf = __alloc(size, 1);
	const iov = __alloc(8, 4);
	storeI32(iov, dataBuf);
	storeI32(iov + 4, size);
	const nreadPtr = __alloc(4, 4);
	wasiCheck(fd_read(fileFd, iov, 1, nreadPtr));
	wasiCheck(fd_close(fileFd));

	// Release only after the bytes are copied into a GC string -- `dataBuf` is a raw pointer, `result` isn't.
	const result = readBytes(dataBuf, size);
	__allocRelease(mark);
	return result;
}

export function writeFileSync(p: string, data: string): void {
	const pre = findPreopen(p);
	const mark = __allocMark();

	const pathBuf = writeBytes(pre.rel);

	const fdOut = __alloc(4, 4);
	// oflags 9 = CREAT (1) | TRUNC (8): create the file if missing, replace its contents if present.
	wasiCheck(path_open(pre.fd, 1, pathBuf, pre.rel.length, 9, rightsWrite(), rightsWrite(), 0, fdOut));
	const fileFd = loadI32(fdOut);

	const dataBuf = writeBytes(data);
	const iov = __alloc(8, 4);
	storeI32(iov, dataBuf);
	storeI32(iov + 4, data.length);
	const nwrittenPtr = __alloc(4, 4);
	wasiCheck(fd_write(fileFd, iov, 1, nwrittenPtr));
	wasiCheck(fd_close(fileFd));

	// Nothing here escapes past this point -- void return, safe to release.
	__allocRelease(mark);
}

export function mkdirSync(p: string): void {
	const pre = findPreopen(p);
	const mark = __allocMark();
	const pathBuf = writeBytes(pre.rel);
	path_create_directory(pre.fd, pathBuf, pre.rel.length);	// an existing directory is not an error here
	__allocRelease(mark);
}
