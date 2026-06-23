import {tison} from '../src/tison';

// ===================================================================
//  Self-test
// ===================================================================

const NUMBER = /[0-9]+(?:\.[0-9]+)?/;

const lexParser = tison({
    skip: [/\s+/],
    precedence: {
        additive:		'left',
        multiplicative:	'left',
        unary:			'right',
    },
    start: 'expr',
    rules: {
        expr: [
            { rhs: ['expr', '+', 'expr'], action: $ => ($[0] as number) + ($[2] as number), prec: 'additive' },
            { rhs: ['expr', '-', 'expr'], action: $ => ($[0] as number) - ($[2] as number), prec: 'additive' },
            { rhs: ['expr', '*', 'expr'], action: $ => ($[0] as number) * ($[2] as number), prec: 'multiplicative' },
            { rhs: ['expr', '/', 'expr'], action: $ => ($[0] as number) / ($[2] as number), prec: 'multiplicative' },
            { rhs: ['-', 'expr'], action: $ => -($[1] as number), prec: 'unary' },
            { rhs: ['(', 'expr', ')'], action: $ => $[1] },
            { rhs: [NUMBER], action: $ => parseFloat($[0] as string) },
        ],
    },
});

console.log('3 + 4 * 5 =', lexParser.parse('3 + 4 * 5'));    // 23
console.log('(3 + 4) * 5 =', lexParser.parse('(3 + 4) * 5'));  // 35
console.log('-3 * 2 =', lexParser.parse('-3 * 2'));       // -6
console.log('10 / 2 + 1 =', lexParser.parse('10 / 2 + 1'));   // 6
console.log('2.5 * 4 =', lexParser.parse('2.5 * 4'));      // 10
