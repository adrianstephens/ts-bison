import {makeParser, Ref, Rules, Rule, WithPrec, ForceFork} from '../src/tison';
import { RuleR } from '../src/rrule';

// ===================================================================
//  Self-test
// ===================================================================

const NUMBER = /[0-9]+(?:\.[0-9]+)?/;

const lexParser = makeParser({
    skip: [/\s+/],
    precedence: {
        additive:		'left',
        multiplicative:	'left',
        unary:			'right',
    },
    start: Rules(self => [
        { rhs: [self, '+', (x: any) => {console.log('hello', x); return 42;}, self], action: $ => ($[0] as number) + ($[2] as number), prec: 'additive' },
        { rhs: [self, '-', self], action: $ => ($[0] as number) - ($[2] as number), prec: 'additive' },
        { rhs: [self, '*', self], action: $ => ($[0] as number) * ($[2] as number), prec: 'multiplicative' },
        { rhs: [self, '/', self], action: $ => ($[0] as number) / ($[2] as number), prec: 'multiplicative' },
        { rhs: ['-', self], action: $ => -($[1] as number), prec: 'unary' },
        { rhs: ['(', self, ')'], action: $ => $[1] },
        { rhs: [NUMBER], action: $ => parseFloat($[0] as string) },
    ]),
});

console.log('3 + 4 * 5 =', lexParser.parse('3 + 4 * 5'));    // 23
console.log('(3 + 4) * 5 =', lexParser.parse('(3 + 4) * 5'));  // 35
console.log('-3 * 2 =', lexParser.parse('-3 * 2'));       // -6
console.log('10 / 2 + 1 =', lexParser.parse('10 / 2 + 1'));   // 6
console.log('2.5 * 4 =', lexParser.parse('2.5 * 4'));      // 10

const ref = Ref('expression');

const lexParser2 = makeParser({
    skip: [/\s+/],
    precedence: {
        additive:		'left',
        multiplicative:	'left',
        unary:			'right',
    },
    rules: {
        expression: Rules(
            { rhs: [ref, '+', ref], action: $ => ($[0] as number) + ($[2] as number), prec: 'additive' },
            { rhs: [ref, '-', ref], action: $ => ($[0] as number) - ($[2] as number), prec: 'additive' },
            { rhs: [ref, '*', ref], action: $ => ($[0] as number) * ($[2] as number), prec: 'multiplicative' },
            { rhs: [ref, '/', ref], action: $ => ($[0] as number) / ($[2] as number), prec: 'multiplicative' },
            { rhs: ['-', ref], action: $ => -($[1] as number), prec: 'unary' },
            { rhs: ['(', ref, ')'], action: $ => $[1] },
            { rhs: [NUMBER], action: $ => parseFloat($[0] as string) },
        )
    },
});

console.log('3 + 4 * 5 =', lexParser2.parse('3 + 4 * 5'));    // 23
console.log('(3 + 4) * 5 =', lexParser2.parse('(3 + 4) * 5'));  // 35
console.log('-3 * 2 =', lexParser2.parse('-3 * 2'));       // -6
console.log('10 / 2 + 1 =', lexParser2.parse('10 / 2 + 1'));   // 6
console.log('2.5 * 4 =', lexParser2.parse('2.5 * 4'));      // 10

const lexParser3 = makeParser({
    skip: [/\s+/],
    precedence: {
        additive:		'left',
        multiplicative:	'left',
        unary:			'right',
    },
    rules: {
        expression: Rules<number>(self => [
            WithPrec(RuleR(self, '+', self, $ => $[0] + $[2]), 'additive'),
            WithPrec(RuleR(self, '-', self, $ => $[0] - $[2]), 'additive'),
            WithPrec(RuleR(self, '*', self, $ => $[0] * $[2]), 'multiplicative'),
            WithPrec(RuleR(self, '/', self, $ => $[0] / $[2]), 'multiplicative'),
            WithPrec(RuleR('-', self, 		$ => -$[1]), 'unary'),
            RuleR('(', self, ')', 			$ => $[1]),
            RuleR(NUMBER, 					$ => parseFloat($[0])),
        ])
    },
});

console.log('3 + 4 * 5 =', lexParser3.parse('3 + 4 * 5'));    // 23
console.log('(3 + 4) * 5 =', lexParser3.parse('(3 + 4) * 5'));  // 35
console.log('-3 * 2 =', lexParser3.parse('-3 * 2'));       // -6
console.log('10 / 2 + 1 =', lexParser3.parse('10 / 2 + 1'));   // 6
console.log('2.5 * 4 =', lexParser3.parse('2.5 * 4'));      // 10

// GLR forkCtx: each fork branch runs its actions on its own ctx clone, so the dying branch's
// mutation can't leak; the winning branch's clone is adopted for the rest of the parse.
const forkGrammar = (forkCtx?: (ctx: any) => any) => {
    const A = Rules(ForceFork(Rule(['a'] as const, (_, ctx) => { ctx.a++; return 'A'; })));
    const B = Rules(Rule(['a'] as const, (_, ctx) => { ctx.b++; return 'B'; }));
    return makeParser({
        skip: [/\s+/],
        start: Rules(
            Rule([A, 'x', 'p'] as const, (_, ctx) => ({...ctx})),
            Rule([B, 'x', 'q'] as const, (_, ctx) => ({...ctx})),
        ),
        forkCtx,
    });
};
const shared = forkGrammar().parse('a x q', {a: 0, b: 0}) as any;
const cloned = forkGrammar(ctx => ({...ctx})).parse('a x q', {a: 0, b: 0}) as any;
console.log(`forkCtx: shared a=${shared.a} b=${shared.b}, cloned a=${cloned.a} b=${cloned.b} (want a=0 b=1)`);
if (cloned.a !== 0 || cloned.b !== 1)
    throw new Error('forkCtx clone test failed: dead-branch mutation leaked or winner ctx not adopted');
if (shared.a !== 1 || shared.b !== 1)
    throw new Error('shared-ctx baseline changed');
