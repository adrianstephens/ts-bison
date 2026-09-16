# Grammar table cache (`src/tableCache.ts`) — rewritten 2026-09-15

`makeCachedParser(spec, options, { sources, cachePath })` writes `.tables-cache/*.tables`: a binary file
(magic `TSLR` + `TABLE_FORMAT_VERSION` + option flags + grammar digest + source stamps + varint rows), no
`JSON`/`crypto`/`zlib` (only `fs`+`path`). The file is bigger than the gzipped JSON it replaced (123KB vs
21KB for ts-parser) -- the user's call, 2026-09-15: take the size over another two Node builtins. Validity =
the source stamps AND the digest; the engine's own modules are invalidated by bumping `TABLE_FORMAT_VERSION`
instead. `grammarFingerprint` (sha256 of a JSON snapshot) came back from `lalr.ts` as the JSON-free
`grammarDigest`. Returns `LALRParser<T>`, not `Parser<T>`.

- `sources` must name EVERY example module contributing grammar: ts-parser `[__filename, siblingSource(__filename, 'js-parser')]`,
  cpp-parser `[__filename, siblingSource(__filename, 'c-parser')]`. `siblingSource` exists because a hard-coded `.ts` sibling
  breaks the `dist` build (there it is `.js`); it takes the extension from the caller's own `__filename`. A source left out of
  the list = edits to it leave stale tables, silently. `slr`/`optimize` are in the header (the old fingerprint ignored them).
- One `.tables-cache/<grammar>.tables` per call site, and `src` and `dist` runs share it (`dist/.../ts-parser.js` stamps its own
  sibling `.js`), so alternating ts-node and built-node runs rebuilds each way. Correct, just a rebuild -- not a wrong hit.
- Validity = the source stamps AND `lalr.ts`'s `grammarDigest` (FNV-1a over terminals/patterns/always-lists/
  rules, JSON-free, stored in the header). Stamps ALONE were unsound 2026-09-15: `jsx-parser.add()` pushes
  rules into the shared rule objects *after* the first `make()`, so `TS.make()` came back as the pre-JSX
  grammar -- 1793 states instead of 1869, silently, since every cached index was still in range. Now a miss;
  see the `a grammar changed in memory` case in `test/test-table-cache.ts`.
- That JSX flow also means ts-parser's cache THRASHES: each `test-ts-parser` run writes it twice (no-JSX,
  then JSX) and never hits. Correct, just no caching benefit in that suite. No-cache and cached runs of it
  now agree exactly (GAP/WARNING/ERROR 710/277/182; the pre-digest 712/308 came from the mis-cached parserX,
  while ERROR 182 and `npm run gate`'s 838 were already right).
- Test: `npx ts-node -T test/test-table-cache.ts` — hits/misses via a cache-mtime sentinel, truncation, trailing
  junk, and a row-for-row comparison against a fresh `makeParser`. It caught two real bugs on the first run
  (state count written twice; end-of-file checked before the rows were decoded).
