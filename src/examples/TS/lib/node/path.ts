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
	const absolute = p.charCodeAt(0) === 47;
	const min = absolute ? 1 : 0;

	let end = p.length;
	while (end > min && p.charCodeAt(end - 1) === 47)
		end--;
	let i = end;
	while (i > min && p.charCodeAt(i - 1) !== 47)
		i--;
	while (i > min && p.charCodeAt(i - 1) === 47)
		i--;

	if (i === 0)
		return absolute ? '/' : '.';
	return p.slice(0, i);
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
	return i <= 0 ? '' : base.slice(i);
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
