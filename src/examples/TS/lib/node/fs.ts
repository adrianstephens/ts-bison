/// <reference path="../lib.d.ts" />

import {
	fd_write, fd_read, fd_close, fd_filestat_get,
	fd_prestat_get, fd_prestat_dir_name, fd_readdir,
	path_open, path_create_directory,
} from 'wasi_snapshot_preview1';

const loadU8	= __asm<[i32], i32>('i32.load8_u');
const loadI32	= __asm<[i32], i32>('i32.load');
const loadI64	= __asm<[i32], i64>('i64.load');
const storeU8	= __asm<[i32, i32], void>('i32.store8');
const storeI32	= __asm<[i32, i32], void>('i32.store');

// WASI rights are a capability mask, and `path_open` REFUSES (errno 76, ENOTCAPABLE) any right the parent
// directory fd does not itself hold -- asking for all-ones fails against every real host. Ask for exactly
// what each call uses: fd_read(1<<1) | fd_seek(1<<2) | fd_tell(1<<5) | fd_filestat_get(1<<21), and the
// same with fd_write(1<<6) in place of fd_read.
const RIGHTS_READ: i64	= 2097190;
const RIGHTS_WRITE: i64	= 2097252;
// fd_readdir(1<<14) | fd_filestat_get(1<<21), and `path_open` with oflags DIRECTORY needs
// path_open(1<<13) on the directory itself -- again exactly what is used, never all-ones.
const RIGHTS_DIR: i64	= 2113536;

// A WASI errno as node names it. Only the codes these calls can actually produce -- an unmapped one keeps
// its number rather than being dressed up as something it is not.
function errnoName(errno: i32): string {
	if (errno === 44) return 'ENOENT';
	if (errno === 20) return 'EEXIST';
	if (errno === 31) return 'EISDIR';
	if (errno === 54) return 'ENOTDIR';
	if (errno === 2) return 'EACCES';
	if (errno === 8) return 'EBADF';
	if (errno === 76) return 'ENOTCAPABLE';
	return 'EIO';
}

function errnoText(errno: i32): string {
	if (errno === 44) return 'no such file or directory';
	if (errno === 20) return 'file already exists';
	if (errno === 31) return 'illegal operation on a directory';
	if (errno === 54) return 'not a directory';
	if (errno === 2) return 'permission denied';
	if (errno === 8) return 'bad file descriptor';
	if (errno === 76) return 'capabilities insufficient';
	return 'i/o error';
}

// Throws what node throws, in node's own message format (`ENOENT: no such file or directory, open
// '/p'`), so a caught error compares equal on both sides rather than being a trap no test can observe.
// CONTINUING is still not an option: an ignored errno leaves the out-pointer unwritten, so the next step
// reads whatever was in that scratch as a descriptor or a length -- that is how a failed open became a
// multi-hundred-megabyte allocation, and then a hang.
// `mark` is released BEFORE throwing: the bump allocator reclaims only by restoring a mark, so an
// escaping throw would otherwise leak every buffer this call took. Safe here because the message is a GC
// string built from GC strings -- nothing surviving points into the released region.
function wasiCheck(errno: i32, syscall: string, p: string, mark: i32): void {
	if (errno !== 0) {
		__allocRelease(mark);
		throw new Error(errnoName(errno) + ': ' + errnoText(errno) + ', ' + syscall + " '" + p + "'");
	}
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
	// The length guard matters when `p` IS the preopen root: `rel` is then empty, and `charCodeAt(0)`
	// on an empty string reads element 0 of a zero-length array and traps rather than giving JS's NaN.
	// Only `readdirSync` reaches this -- every other entry point has a filename after the directory.
	if (rel.length > 0 && rel.charCodeAt(0) === 47)
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
	wasiCheck(path_open(pre.fd, 1, pathBuf, pre.rel.length, 0, RIGHTS_READ, RIGHTS_READ, 0, fdOut), 'open', p, mark);
	const fileFd = loadI32(fdOut);

	const statBuf = __alloc(64, 8);
	wasiCheck(fd_filestat_get(fileFd, statBuf), 'fstat', p, mark);
	// filestat.size is a 64-bit field at byte offset 32; wasm is little-endian, so a plain i32.load
	// there reads its low 32 bits, which is exactly the file's size for anything under 4GiB.
	const size = loadI32(statBuf + 32);

	const dataBuf = __alloc(size, 1);
	const iov = __alloc(8, 4);
	storeI32(iov, dataBuf);
	storeI32(iov + 4, size);
	const nreadPtr = __alloc(4, 4);
	wasiCheck(fd_read(fileFd, iov, 1, nreadPtr), 'read', p, mark);
	wasiCheck(fd_close(fileFd), 'close', p, mark);

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
	wasiCheck(path_open(pre.fd, 1, pathBuf, pre.rel.length, 9, RIGHTS_WRITE, RIGHTS_WRITE, 0, fdOut), 'open', p, mark);
	const fileFd = loadI32(fdOut);

	const dataBuf = writeBytes(data);
	const iov = __alloc(8, 4);
	storeI32(iov, dataBuf);
	storeI32(iov + 4, data.length);
	const nwrittenPtr = __alloc(4, 4);
	wasiCheck(fd_write(fileFd, iov, 1, nwrittenPtr), 'write', p, mark);
	wasiCheck(fd_close(fileFd), 'close', p, mark);

	// Nothing here escapes past this point -- void return, safe to release.
	__allocRelease(mark);
}

// Node's `readdirSync`, over `fd_readdir`. A WASI dirent is a fixed 24-byte header -- d_next (u64),
// d_ino (u64), d_namlen (u32), d_type (u8) -- immediately followed by `d_namlen` name bytes, packed with
// no alignment between entries.
//
// The read LOOPS on the cookie rather than assuming one buffer holds the directory: `fd_readdir` fills
// what it can and reports how much, and a caller that stops after one call silently loses entries in any
// directory bigger than the buffer. `d_next` from the last complete entry is the cookie to resume from.
// A trailing PARTIAL entry is normal (it is how the host says "buffer full"), so it is skipped rather
// than treated as an error -- the next round re-reads it whole.
export function readdirSync(p: string): string[] {
	const pre	= findPreopen(p);
	const mark	= __allocMark();
	const pathBuf = writeBytes(pre.rel);

	const fdOut = __alloc(4, 4);
	// oflags 2 = DIRECTORY: fail loudly on a plain file rather than reading a nonsense dirent stream.
	wasiCheck(path_open(pre.fd, 1, pathBuf, pre.rel.length, 2, RIGHTS_DIR, RIGHTS_DIR, 0, fdOut), 'scandir', p, mark);
	const dirFd = loadI32(fdOut);

	const bufLen	= 4096;
	const buf		= __alloc(bufLen, 8);
	const usedPtr	= __alloc(4, 4);
	const result: string[] = [];

	let cookie: i64	= 0;
	let more		= true;
	while (more) {
		wasiCheck(fd_readdir(dirFd, buf, bufLen, cookie, usedPtr), 'scandir', p, mark);
		const used = loadI32(usedPtr);
		// Short of the buffer means the directory is exhausted; a full buffer means there may be more.
		more = used === bufLen;

		let off = 0;
		// `break` is not available in this subset, so "stop at the first incomplete entry" folds into the
		// loop condition -- the same shape `getUnsigned` uses in `lib/number.ts`.
		let stop = false;
		while (!stop && off + 24 <= used) {
			const namlen = loadI32(buf + off + 16);
			if (off + 24 + namlen > used) {
				stop = true;
			} else {
				const name = String.fromCharCodesAt(buf + off + 24, namlen);
				// Node omits these two; WASI reports them.
				if (name !== '.' && name !== '..')
					result.push(name);
				cookie	= loadI64(buf + off);
				off		= off + 24 + namlen;
			}
		}
		// No complete entry fitted at all: the buffer cannot hold this name, and looping would spin.
		if (off === 0)
			more = false;
	}

	wasiCheck(fd_close(dirFd), 'close', p, mark);
	// Every name is already a GC string by now, so the scratch can go back.
	__allocRelease(mark);
	return result;
}

export function mkdirSync(p: string): void {
	const pre = findPreopen(p);
	const mark = __allocMark();
	const pathBuf = writeBytes(pre.rel);
	path_create_directory(pre.fd, pathBuf, pre.rel.length);	// an existing directory is not an error here
	__allocRelease(mark);
}
