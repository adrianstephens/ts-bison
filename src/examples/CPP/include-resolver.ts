import * as fs from 'fs/promises';
import * as path from 'path';
import type { PreprocessOptions } from './preprocessor';

// ===================================================================
//  #include resolution over a real directory tree, with C semantics:
//  `#include "x.h"` searches the including file's directory first,
//  then the search paths; `#include <x.h>` searches only the paths.
//  Contents are cached; unresolvable names return undefined (the
//  preprocessor then skips them silently, e.g. system headers).
// ===================================================================

export function fileResolver(searchPaths: string[]): NonNullable<PreprocessOptions['include']> {
	const cache = new Map<string, string | undefined>();

	const read = async (file: string): Promise<string | undefined> => {
		if (!cache.has(file)) {
			try {
				cache.set(file, await fs.readFile(file, 'utf8'));
			} catch {
				cache.set(file, undefined);
			}
		}
		return cache.get(file);
	};

	return async (name, angled, from) => {
		const dirs = angled ? searchPaths : [path.dirname(from), ...searchPaths];
		for (const dir of dirs) {
			const full = path.resolve(dir, name);
			const source = await read(full);
			if (source !== undefined)
				return { path: full, source };
		}
		return undefined;
	};
}
