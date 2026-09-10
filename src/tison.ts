// tison.ts -- A TypeScript-object-based LALR(1)/SLR(1)/GLR parser generator.
//
// Analogous to GNU Bison, but instead of parsing a .y file you pass a plain TypeScript object that describes your grammar.
// Terminals carry regex patterns, so tison is the lexer too -- you just feed it a string.
//
// This file is just the public barrel: core.ts has the grammar spec types, lexer, and GrammarBuilder;
// lalr.ts and peg.ts are the two back ends built on top of it.

export * from './core';
export * from './lalr';
export * from './peg';
