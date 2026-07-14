import { Rule, Action, Ref, Terminal, Rules, ElemValue } from './tison';

export declare enum E { a, b, c };

export declare type Y = number;

export declare interface X {
	a: number;
	b: string;
}

export interface X {
	c: string;
}

let y: X;
// Rest-parameter alternative to Rule(): pass rhs symbols directly instead of wrapping them in an array literal with `as const`.
// Any parameter may be an inline action -- it's typed against exactly the parameters that precede it.
// The rule's own result defaults to whatever the *last* argument evaluates to

type SymR<A extends readonly unknown[], C = any>		= string | RegExp | Terminal | Rules<any> | (()=>Rules<any>) | Ref<any> | Action<any, C, ValuesOfR<A>>;
type RSymR<T, A extends readonly unknown[], C = any>	= Terminal<T> | Rules<T> | (()=>Rules<T>) | Ref<T> | Action<T, C, ValuesOfR<A>>;
type ValuesOfR<T extends readonly unknown[]>			= { [K in keyof T]: ElemValue<T[K]> };

// Pins `ctx`'s type to `C` for every rule built with the returned function
export function makeRuleR<C>() {
	function boundRule<T, S1 extends RSymR<T, [], C>>(s1: S1): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends RSymR<T, [S1], C>>(s1: S1, s2: S2): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends RSymR<T, [S1, S2], C>>(s1: S1, s2: S2, s3: S3): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends RSymR<T, [S1, S2, S3], C>>(s1: S1, s2: S2, s3: S3, s4: S4): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends RSymR<T, [S1, S2, S3, S4], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends RSymR<T, [S1, S2, S3, S4, S5], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends RSymR<T, [S1, S2, S3, S4, S5, S6], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8], C>, S10 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8, S9], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9, s10: S10): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8], C>, S10 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8, S9], C>, S11 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9, s10: S10, s11: S11): Rule<T>;
	function boundRule<T, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8], C>, S10 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8, S9], C>, S11 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8, S9, S10], C>, S12 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9, s10: S10, s11: S11, s12: S12): Rule<T>;
	function boundRule(...syms: any) {
		const last = syms.at(-1);
		if (typeof last === 'function' && last.length > 0)
			return Rule(syms.slice(0, -1), last);
		return Rule(syms, (values: any[]) => values[values.length - 1]);
	}
	return boundRule;
}
export const RuleR = makeRuleR<any>();
