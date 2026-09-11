/// <reference path="../lib.d.ts" />

//-----------------------------------------------------------------------------
//	path -- POSIX ('/') semantics only, pure string manipulation, no WASI
//-----------------------------------------------------------------------------

export const sep = '/';

// Hand-rolled rather than `String.split`: a plain byte scan, no need to pull in RegExp machinery
// for it. Consecutive/leading/trailing slashes never produce empty segments.
function splitSegments(p: string): string[] {
	const segs: string[] = [];
	const n = p.length;
	let start = 0;
	for (let i = 0; i <= n; i++) {
		if (i === n || p.charCodeAt(i) === 47) {
			if (i > start)
				segs.push(p.slice(start, i));
			start = i + 1;
		}
	}
	return segs;
}

function normalizeSegments(segs: string[], absolute: boolean): string[] {
	const out: string[] = [];
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		if (seg === '.')
			continue;
		if (seg === '..') {
			if (out.length > 0 && out[out.length - 1] !== '..')
				out.pop();
			else if (!absolute)
				out.push(seg);
		} else {
			out.push(seg);
		}
	}
	return out;
}

export function join(...parts: string[]): string {
	const segs: string[] = [];
	const absolute = parts.length > 0 && parts[0].length > 0 && parts[0].charCodeAt(0) === 47;
	for (let i = 0; i < parts.length; i++) {
		const s = splitSegments(parts[i]);
		for (let j = 0; j < s.length; j++)
			segs.push(s[j]);
	}
	const last = parts.length > 0 ? parts[parts.length - 1] : '';
	const trailingSlash = last.length > 0 && last.charCodeAt(last.length - 1) === 47;

	const norm = normalizeSegments(segs, absolute);
	let result = norm.join('/');
	if (absolute)
		result = '/' + result;
	if (trailingSlash && (result.length === 0 || result.charCodeAt(result.length - 1) !== 47))
		result = result + '/';
	return result.length === 0 ? '.' : result;
}

export function dirname(p: string): string {
	if (p.length === 0)
		return '.';
	const hasRoot = p.charCodeAt(0) === 47;
	// node's own scan, and worth keeping literally: it takes the FIRST slash above the trailing run and
	// does NOT collapse a run below it, so `dirname('a//b')` is `'a/'` and `dirname('a///b//c')` is
	// `'a///b/'`. Collapsing (the obvious reading) disagrees with node on every repeated separator.
	let end = -1;
	let matchedSlash = true;
	for (let i = p.length - 1; i >= 1; i--) {
		if (p.charCodeAt(i) === 47) {
			if (!matchedSlash) {
				end = i;
				break;
			}
		} else {
			matchedSlash = false;
		}
	}
	if (end === -1)
		return hasRoot ? '/' : '.';
	if (hasRoot && end === 1)
		return '//';
	return p.slice(0, end);
}

export function basename(p: string, ext: string = ''): string {
	let end = p.length;
	while (end > 0 && p.charCodeAt(end - 1) === 47)
		end--;
	let start = end;
	while (start > 0 && p.charCodeAt(start - 1) !== 47)
		start--;

	let name = p.slice(start, end);
	if (ext.length > 0 && name.length > ext.length && name.slice(name.length - ext.length) === ext)
		name = name.slice(0, name.length - ext.length);
	return name;
}

export function extname(p: string): string {
	const base = basename(p);
	const i = base.lastIndexOf('.');
	return i <= 0 || base === '..' ? '' : base.slice(i);
}

export const delimiter = ':';

export function isAbsolute(p: string): boolean {
	return p.length > 0 && p.charCodeAt(0) === 47;
}

export function normalize(p: string): string {
	if (p.length === 0)
		return '.';
	const absolute = p.charCodeAt(0) === 47;
	const trailingSlash = p.charCodeAt(p.length - 1) === 47;
	let result = normalizeSegments(splitSegments(p), absolute).join('/');
	if (result.length === 0 && !absolute)
		result = '.';
	if (result.length > 0 && trailingSlash)
		result = result + '/';
	return absolute ? '/' + result : result;
}

export function relative(from: string, to: string): string {
	const f = splitSegments(resolve(from)), t = splitSegments(resolve(to));
	let common = 0;
	while (common < f.length && common < t.length && f[common] === t[common])
		common++;
	const up: string[] = [];
	for (let i = common; i < f.length; i++)
		up.push('..');
	return up.concat(t.slice(common)).join('/');
}

export interface ParsedPath { root: string; dir: string; base: string; ext: string; name: string }

export function parse(p: string): ParsedPath {
	const root = isAbsolute(p) ? '/' : '';
	let end = p.length;
	while (end > 1 && p.charCodeAt(end - 1) === 47)
		end--;
	let start = end;
	while (start > 0 && p.charCodeAt(start - 1) !== 47)
		start--;
	const base = p.slice(start, end);
	const ext = base === '/' ? '' : extname(base);
	return {
		root,
		dir:	start > 1 ? p.slice(0, start - 1) : root,
		base:	base === '/' ? '' : base,
		ext,
		name:	base === '/' ? '' : base.slice(0, base.length - ext.length),
	};
}

export function format(p: { root?: string; dir?: string; base?: string; name?: string; ext?: string }): string {
	const dir = p.dir || p.root || '';
	const base = p.base || (p.name || '') + (p.ext ? (p.ext.charCodeAt(0) === 46 ? p.ext : '.' + p.ext) : '');
	return !dir ? base : dir === p.root ? dir + base : dir + '/' + base;
}

// No `process.cwd()` exists in this runtime: a non-absolute argument list resolves against '/'
// rather than a real working directory.
export function resolve(...parts: string[]): string {
	let result = '';
	let absolute = false;
	for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
		const p = parts[i];
		if (p.length === 0)
			continue;
		result = result.length === 0 ? p : p + '/' + result;
		if (p.charCodeAt(0) === 47)
			absolute = true;
	}
	const segs = normalizeSegments(splitSegments(result), true);
	return '/' + segs.join('/');
}
