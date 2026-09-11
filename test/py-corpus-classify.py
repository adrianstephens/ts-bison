#!/usr/bin/env python3
# Batch oracle for the PY corpus harness (py-corpus.ts): parses each file with the REAL
# Python `ast` module and flags syntax this parser deliberately doesn't support (soft-keyword
# `match` statements, PEP 695 generics/`type` aliases) -- derived from the real grammar, not a
# curated list, mirroring how ts-corpus.ts asks the real tsc AST about `<T>expr` casts.
#
# Usage: python3 py-corpus-classify.py <root-dir>
# Emits one JSON object per line on stdout: {"path": "<abs path>", "unsupported": "<reason>"|null}

import ast
import json
import os
import sys
import tokenize

EXCLUDE_DIRS = {'test', 'idle_test', '__pycache__'}

def classify(tree: ast.AST) -> str | None:
	for node in ast.walk(tree):
		if isinstance(node, ast.Match):
			return 'match statement'
		if isinstance(node, ast.TypeAlias):
			return 'type alias statement (PEP 695)'
		if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and getattr(node, 'type_params', None):
			return 'PEP 695 generic type params'
	return None

def main(root: str) -> None:
	for dirpath, dirnames, filenames in os.walk(root):
		dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
		for name in filenames:
			if not name.endswith('.py'):
				continue
			path = os.path.join(dirpath, name)
			try:
				with tokenize.open(path) as f:
					source = f.read()
				tree = ast.parse(source, filename=path)
				reason = classify(tree)
			except SyntaxError as e:
				reason = f'unparseable by CPython itself: {e}'
			print(json.dumps({'path': path, 'unsupported': reason}))

if __name__ == '__main__':
	main(sys.argv[1])
