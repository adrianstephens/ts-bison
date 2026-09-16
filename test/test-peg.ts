import { makeParser, makePegParser, pegDiagnostics, Rules, Rule, WithPrec, MaybeList, Maybe, And, Not, terminal, type GrammarSpec } from '../dist/tison';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  ok   ${name} = ${a}`);
	} else {
		console.error(`  FAIL ${name}: got ${a}, expected ${e}`);
		failures++;
		process.exitCode = 1;
	}
}

function checkThrows(name: string, fn: () => unknown, match: RegExp) {
	try {
		const value = fn();
		console.error(`  FAIL ${name}: expected a throw, got ${JSON.stringify(value)}`);
		failures++;
		process.exitCode = 1;
	} catch (e) {
		const msg = (e as Error).message;
		if (match.test(msg)) {
			console.log(`  ok   ${name} threw: ${msg.split('\n')[0]}`);
		} else {
			console.error(`  FAIL ${name}: threw ${JSON.stringify(msg)}, expected /${match.source}/`);
			failures++;
			process.exitCode = 1;
		}
	}
}

function section(name: string) {
	console.log(`\n=== ${name} ===`);
}

// ===================================================================
//  Precedence, associativity, direct left recursion
// ===================================================================
// The README's grammar verbatim: left-recursive with declared precedence levels, i.e. everything PEG is
// classically bad at. Every case is cross-checked against the LR back end on the *same* spec value.

const NUMBER = /[0-9]+(?:\.[0-9]+)?/;

const arith: GrammarSpec<number> = {
	skip: [/\s+/],
	precedence: {
		additive:		'left',
		multiplicative:	'left',
		power:			'right',
		unary:			'right',
	},
	start: Rules<number>(self => [
		WithPrec(Rule([self, '+', self] as const,	$ => $[0] + $[2]), 'additive'),
		WithPrec(Rule([self, '-', self] as const,	$ => $[0] - $[2]), 'additive'),
		WithPrec(Rule([self, '*', self] as const,	$ => $[0] * $[2]), 'multiplicative'),
		WithPrec(Rule([self, '/', self] as const,	$ => $[0] / $[2]), 'multiplicative'),
		WithPrec(Rule([self, '^', self] as const,	$ => $[0] ** $[2]), 'power'),
		WithPrec(Rule(['-', self] as const,			$ => -$[1]), 'unary'),
		Rule(['(', self, ')'] as const,				$ => $[1]),
		Rule([NUMBER],								$ => parseFloat($[0])),
	]),
};

section('arithmetic: PEG vs LR on one grammar');
{
	const peg = makePegParser(arith);
	const lr  = makeParser(arith);
	for (const [text, expected] of [
		['3 + 4 * 5',		23],
		['(3 + 4) * 5',		35],
		['-3 * 2',			-6],
		['10 / 2 + 1',		6],
		['2.5 * 4',			10],
		['3 * 4 + 5',		17],		// the case naive PEG gets wrong: precedence must win over greed
		['2 - 3 - 4',		-5],		// left associative
		['2 ^ 3 ^ 2',		512],		// right associative
		['2 ^ 2 * 3',		12],		// binds tighter than *
		['-2 ^ 2',			4],			// `unary` is the highest declared level, so it binds tighter than ^
		['1 + 2 * 3 - 4 / 2',	5],
	] as const) {
		check(`peg ${text}`, peg.parse(text), expected);
		check(`lr  ${text}`, lr.parse(text), expected);
	}
}

section('arithmetic: errors and prefixes');
{
	const peg = makePegParser(arith);
	checkThrows('unclosed paren', () => peg.parse('(1 + 2'), /Expected:/);
	checkThrows('trailing junk', () => peg.parse('1 + 2 )'), /line 1, col 7/);
	checkThrows('empty input', () => peg.parse(''), /end of input/);
	check('parsePrefix', peg.parsePrefix('1 + 2 ) rest'), { value: 3, consumed: 5 });
}

// ===================================================================
//  Ordered choice
// ===================================================================

section('ordered choice');
{
	// Under LR this is an ambiguity resolved by the tables; under PEG the first alternative simply wins.
	const spec: GrammarSpec<string> = {
		skip: [/\s+/],
		start: Rules<string>(
			Rule(['a', 'b'] as const,		() => 'ab'),
			Rule(['a', 'b', 'c'] as const,	() => 'abc'),
		),
	};
	// 'a b c' can only be the second alternative -- but PEG commits to the first, which then leaves 'c'
	// unconsumed. That's the defining PEG behaviour, not a bug, so assert it rather than working around it.
	check('first alternative wins', makePegParser(spec).parse('a b'), 'ab');
	checkThrows('no backtracking into a committed choice', () => makePegParser(spec).parse('a b c'), /line 1, col 5/);

	// Reordering fixes it, again purely by choice order.
	const reordered: GrammarSpec<string> = {
		skip: [/\s+/],
		start: Rules<string>(
			Rule(['a', 'b', 'c'] as const,	() => 'abc'),
			Rule(['a', 'b'] as const,		() => 'ab'),
		),
	};
	check('longer alternative first', makePegParser(reordered).parse('a b c'), 'abc');
	check('shorter still matches', makePegParser(reordered).parse('a b'), 'ab');
}

section('epsilon alternatives are normalized to last');
{
	// Maybe() puts its empty alternative first (harmless for LR). Taken literally as an ordered choice it
	// would always match nothing and leave the real alternative unreachable.
	const spec: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: {
			start:	Rules(Rule(['x', Maybe(Rules(Rule(['y'] as const, () => 'y')))] as const, $ => `x${$[1] ?? '-'}`)),
		},
	};
	const peg = makePegParser(spec);
	check('Maybe present', peg.parse('x y'), 'xy');
	check('Maybe absent', peg.parse('x'), 'x-');
}

section('greedy repetition via List/MaybeList');
{
	const spec: GrammarSpec<string[]> = {
		skip: [/\s+/],
		rules: {
			start:	Rules(Rule(['[', MaybeList(Rules(Rule([/[a-z]+/] as const, $ => $[0])), ','), ']'] as const, $ => $[1])),
		},
	};
	const peg = makePegParser(spec);
	check('list', peg.parse('[a, b, c]'), ['a', 'b', 'c']);
	check('singleton', peg.parse('[a]'), ['a']);
	check('empty', peg.parse('[]'), []);
	check('lr agrees', makeParser(spec).parse('[a, b, c]'), ['a', 'b', 'c']);
}

// ===================================================================
//  Syntactic predicates
// ===================================================================

section('And()/Not() predicates');
{
	const IDENT = terminal('IDENT', /[a-z]+/);
	// 'direct' lexing: each terminal is tried on its own, so IDENT happily matches "if" and only the
	// Not() guard keeps a keyword out of identifier position -- the classic PEG idiom.
	const spec: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: {
			start: Rules<string>(
				Rule(['if', Rules(Rule([Not('if'), IDENT] as const, $ => $[1]))] as const, $ => `if(${$[1]})`),
				Rule([Not('if'), IDENT] as const, $ => `id(${$[1]})`),
			),
		},
	};
	const peg = makePegParser(spec, { lex: 'direct' });
	check('guarded identifier', peg.parse('foo'), 'id(foo)');
	check('keyword then identifier', peg.parse('if foo'), 'if(foo)');
	checkThrows('Not() blocks the keyword', () => peg.parse('if if'), /Expected:/);
	// A bare identifier is still allowed to *start* with the keyword's letters.
	check('Not() is not a prefix ban', peg.parse('iffy'), 'id(iffy)');

	// And(): lookahead that must match but consumes nothing.
	const lookahead: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: { start: Rules(Rule([And(/[0-9]/), /[0-9a-z]+/] as const, $ => `digit-led:${$[1]}`)) },
	};
	const peg2 = makePegParser(lookahead, { lex: 'direct' });
	check('And() consumes nothing', peg2.parse('1abc'), 'digit-led:1abc');
	checkThrows('And() gates', () => peg2.parse('abc'), /Expected:/);

	checkThrows('predicates are rejected by the LR back end', () => makeParser(lookahead), /PEG-only|makePegParser/);
}

section('maxmunch vs direct lexing');
{
	const IDENT = terminal('IDENT', /[a-z]+/);
	const spec: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: { start: Rules<string>(Rule([IDENT] as const, $ => `id:${$[0]}`), Rule(['if'] as const, () => 'kw')) },
	};
	// Default 'maxmunch' lexes with every terminal competing, exactly like the LR back end: 'if' is a
	// longer... equal-length match, and the literal wins the tie, so the keyword is never seen as IDENT.
	check('maxmunch picks the keyword', makePegParser(spec).parse('if'), 'kw');
	// 'direct' tries only the terminal the grammar asks for, in choice order -- IDENT is first, so it wins.
	check('direct follows choice order', makePegParser(spec, { lex: 'direct' }).parse('if'), 'id:if');
}

// ===================================================================
//  Left-recursion diagnostics
// ===================================================================

section('left recursion diagnostics');
{
	check('direct left recursion is fine', pegDiagnostics(arith), []);

	// a -> b 'x' | 'z'  /  b -> a 'y' | 'w'   -- a cycle with nothing consumed before re-entry.
	const indirect: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: {
			a: Rules<string>(Rule(['b', 'x'] as const, $ => `${$[0]}x`), Rule(['z'] as const, () => 'z')),
			b: Rules<string>(Rule(['a', 'y'] as const, $ => `${$[0]}y`), Rule(['w'] as const, () => 'w')),
		},
	};
	check('indirect cycle reported', pegDiagnostics(indirect).length, 1);
	checkThrows('indirect cycle rejected', () => makePegParser(indirect), /error: indirect left recursion between '[ab]' and '[ab]'/);

	// a -> maybe a 'x' | 'z', where `maybe` is nullable: still left recursion, but seed growing can't
	// express it (the recursive symbol isn't rhs[0]).
	const nullablePrefix: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: {
			opt:	Rules<string>(Rule([], () => ''), Rule(['@'] as const, () => '@')),
			a:		Rules<string>(Rule(['opt', 'a', 'x'] as const, $ => `${$[1]}x`), Rule(['z'] as const, () => 'z')),
		},
	};
	checkThrows('nullable-prefix recursion rejected', () => makePegParser(nullablePrefix), /nullable prefix/);
}

section('shadowed-alternative warnings');
{
	// Alternative order is irrelevant to LR, so this is how a grammar written for it silently loses an
	// alternative under ordered choice -- warned about, but still built (PEG really does behave this way).
	const spec: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: {
			decl:	Rules<string>(
				Rule([/[a-z]+/] as const,						$ => `bare:${$[0]}`),
				Rule([/[a-z]+/, '=', /[0-9]+/] as const,		$ => `init:${$[0]}=${$[2]}`),
				Rule([/[a-z]+/] as const,						$ => 'unreachable'),
			),
		},
	};
	const problems = pegDiagnostics(spec);
	check('one shadow + one duplicate', problems.length, 2);
	check('shadowing warned', problems.some(p => /shadows the later/.test(p)), true);
	check('duplicate warned', problems.some(p => /duplicate alternative/.test(p)), true);
	check('warnings do not block the build', makePegParser(spec).parse('x'), 'bare:x');
	checkThrows('and the shadowed alternative really is unreachable', () => makePegParser(spec).parse('x = 1'), /Expected: end of input/);

	// Reordered, both alternatives are reachable and the warnings are gone.
	const fixed: GrammarSpec<string> = {
		skip: [/\s+/],
		rules: {
			decl:	Rules<string>(
				Rule([/[a-z]+/, '=', /[0-9]+/] as const,	$ => `init:${$[0]}=${$[2]}`),
				Rule([/[a-z]+/] as const,					$ => `bare:${$[0]}`),
			),
		},
	};
	check('reordered is clean', pegDiagnostics(fixed), []);
	check('reordered parses the long form', makePegParser(fixed).parse('x = 1'), 'init:x=1');
	check('reordered still parses the short form', makePegParser(fixed).parse('x'), 'bare:x');
}

// ===================================================================
//  Actions, ctx and mid-rule actions
// ===================================================================

section('actions, ctx and mid-rule actions');
{
	interface Ctx { seen: string[] }
	const spec: GrammarSpec<string> = {
		skip: [/\s+/],
		start: Rules<string>(
			Rule(['a', ($: any, ctx: Ctx) => { ctx.seen.push(`mid:${$[0]}`); return 'M'; }, 'b'] as const,
				($, ctx: Ctx) => { ctx.seen.push('done'); return `${$[0]}${$[1]}${$[2]}`; }),
		),
	};
	const ctx: Ctx = { seen: [] };
	check('mid-rule action value lands in $[1]', makePegParser(spec).parse('a b', ctx), 'aMb');
	check('mid-rule action saw preceding values', ctx.seen, ['mid:a', 'done']);
}

section('$.pos is the start of the match');
{
	const spec: GrammarSpec<unknown> = {
		skip: [/\s+/],
		start: Rules(Rule([/[0-9]+/, '+', /[0-9]+/] as const, $ => ({ line: $.pos.line, col: $.pos.col }))),
	};
	check('pos', makePegParser(spec).parse('\n  12 + 34'), { line: 2, col: 3 });
}

// ===================================================================
//  Memoization
// ===================================================================

section('memoization');
{
	// Deeply nested parens: without memoization the repeated re-parsing of the same position by successive
	// alternatives is what makes naive backtracking blow up. Just check both settings agree.
	const depth = 200;
	const text = '('.repeat(depth) + '1' + ')'.repeat(depth);
	check('memo on', makePegParser(arith, { maxDepth: 5000 }).parse(text), 1);
	check('memo off', makePegParser(arith, { memo: false, maxDepth: 5000 }).parse(text), 1);
}

section('depth guard');
{
	checkThrows('runaway depth throws rather than overflowing the stack',
		() => makePegParser(arith, { maxDepth: 20 }).parse('('.repeat(100) + '1' + ')'.repeat(100)),
		/recursion depth exceeded 20/);
}

// ===================================================================
//  A whole small language
// ===================================================================

section('JSON');
{
	// Stratified rather than precedence-declared -- how a PEG is normally written, and the shape that needs
	// no left recursion at all.
	const STRING	= terminal('string', /"(?:[^"\\]|\\.)*"/);
	const NUM		= terminal('number', /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/);

	const value: Rules<unknown> = Rules<unknown>(self => [
		Rule([STRING],											$ => JSON.parse($[0])),
		Rule([NUM],												$ => parseFloat($[0])),
		Rule(['true'] as const,									() => true),
		Rule(['false'] as const,								() => false),
		Rule(['null'] as const,									() => null),
		Rule(['[', MaybeList(self, ','), ']'] as const,			$ => $[1]),
		Rule(['{', MaybeList(Rules(Rule([STRING, ':', self] as const, $ => [JSON.parse($[0]), $[2]] as const)), ','), '}'] as const,
																$ => Object.fromEntries($[1])),
	]);
	const spec: GrammarSpec<unknown> = { skip: [/\s+/], start: value };

	check('json grammar is a clean PEG', pegDiagnostics(spec), []);
	const peg = makePegParser(spec);
	const doc = '{"a": [1, 2.5, -3e2], "b": {"c": null, "d": [true, false]}, "e": "x\\ny"}';
	check('json matches JSON.parse', peg.parse(doc), JSON.parse(doc));
	check('json matches the LR back end', makeParser(spec).parse(doc), JSON.parse(doc));
	checkThrows('json trailing comma', () => peg.parse('[1, 2,]'), /line 1, col 7/);
	checkThrows('json unterminated', () => peg.parse('{"a": '), /end of input/);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall PEG tests passed');
