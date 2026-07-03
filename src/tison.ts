// tison.ts -- A TypeScript-object-based SLR(1)/GLR parser generator.
//
// Analogous to GNU Bison, but instead of parsing a .y file you pass a plain TypeScript object that describes your grammar.
// Terminals carry regex patterns, so tison is the lexer too -- you just feed it a string.

// ===================================================================
//  Public API types
// ===================================================================

export type Assoc = 'left' | 'right' | 'nonassoc' | 'fork';
export interface PrecEntry {
	assoc:		Assoc;
	level?:		number;
}
export type Precedence = string | PrecEntry;
export const forceFork: PrecEntry = {assoc:'fork', level: 0};

function has0args<T>(fn: (() => T) | Action<T>): fn is ()=>T {
	return fn.length === 0;
}

// A literal that ends in a word character (e.g. 'var', 'in') is given an implicit trailing word-boundary, so it can never match as a strict prefix of a longer word
function literalPattern(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w/.test(s[s.length - 1]) ? '(?!\\w)' : '');
}

interface Ref<T> { ref: string; }
export function Ref<T>(ref: string): Ref<T> {
	return {ref};
}
export function Forward<T>(ref: () => any) {
	return ref as (() => Rules<T>);
}
export interface TextPos {
	offset: number; line: number; col: number;
}

export interface Token {
	type:	Terminal;
	value:	string;	// semantic value; available as $[i] in actions
	pos?:	TextPos;
}

export interface LexPosition extends TextPos {
	prev?:		Token;	// the most recently shifted token
	remaining:	string;	// raw remaining input from this position onward
}

// Context given to a terminal's `lex` callback once its pattern has matched at the current position.
//   - return undefined to reject the match (it won't compete this round, so a shorter match from a different terminal can win instead)
//   - return the terminal itself to accept it normally
//   - return a different terminal to reclassify the match as that instead
// `next` looks past this match non-destructively, for terminals (like whitespace) that need to know what's coming to decide how to classify themselves
export interface LexContext extends LexPosition {
	match:		string;	// the text this terminal just matched
	next(): 	Token | undefined;
}

export type TerminalCallback<C = any> = (lexctx: LexContext, ctx: C) => Terminal | string | RegExp | undefined;
export type RecoveryCallback = (lex: LexPosition, row: Map<Terminal, ActionEntry>) => Token | undefined;

export class Terminal<T = any> {
	_ignore = false;
	pattern?: RegExp;
	constructor(public name: string, pattern?: RegExp, public callback?: TerminalCallback) {
		if (pattern)
			this.pattern = new RegExp(pattern.source, 'y' + pattern.flags.replace(/[gyd]/g, ''));
	}
}

export function termOneOf<T extends string>(names: readonly T[]) {
	const sorted = [...names].sort((a, b) => b.length - a.length);
	return new Terminal<T>(names.join('|'), RegExp(sorted.map(literalPattern).join('|')));
}

export function terminal(name: string, pattern?: RegExp, lex?: TerminalCallback) {
	return new Terminal<string>(name, pattern, lex);
}

type Action<T, C = any, A = any[]> = (values: A, ctx: C) => T
type Sym<C = any> = string | RegExp | Terminal | Rules<any> | (()=>Rules<any>) | Ref<any> | Action<any, C>;

type ElemValue<S> = S extends Rule<infer U>[] ? U
	: S extends RegExp ? string
	: S extends Terminal<infer U> ? U
	: S extends (()=>infer U) ? ElemValue<U>
	: S extends Ref<infer U> ? U
	: S extends string ? S
	: S extends Action<infer U> ? U
	: unknown;

type ValuesOf<T extends readonly Sym[]> = {[K in keyof T]: ElemValue<T[K]>}

/*
export interface Rule<T> {
	rhs:		Sym[];
	action?:	(values: any[], ctx: any) => T;
	prec?:		Precedence;
}
*/
export type Rule<T> = Rules<T> | {
	rhs:		Sym[];
	action?:	(values: any[], ctx: any) => T;
	prec?:		Precedence;
}

export function Rule<R extends readonly Sym[]>(rhs: R): Rule<ElemValue<R[0]>>;
export function Rule<T, R extends readonly Sym[], C = any>(rhs: R, action: Action<T, C, ValuesOf<R>>, prec?: Precedence): Rule<T>;
export function Rule(rhs: Sym[], action?: Action<any, any>, prec?: Precedence) {
	return { rhs, action, prec };
}

// Pins `ctx`'s type to `C` for every rule built with the returned function
export function makeRule<C>() {
	function boundRule<R extends readonly Sym<C>[]>(rhs: R): Rule<ElemValue<R[0]>>;
	function boundRule<T, R extends readonly Sym<C>[]>(rhs: R, action: Action<T, C, ValuesOf<R>>, prec?: Precedence): Rule<T>;
	function boundRule(rhs: Sym[], action?: Action<any, any>, prec?: Precedence) {
		return { rhs, action, prec };
	}
	return boundRule;
}
//export const Rule = makeRule<any>;


// Rest-parameter alternative to Rule(): pass rhs symbols directly instead of wrapping them in an array literal with `as const`.
// Any parameter may be an inline action -- it's typed against exactly the parameters that precede it.
// The rule's own result defaults to whatever the *last* argument evaluates to

type SymR<A extends readonly unknown[], C = any> = string | RegExp | Terminal | Rules<any> | (()=>Rules<any>) | Ref<any> | Action<any, C, ValuesOfR<A>>;
type RSymR<T, A extends readonly unknown[], C = any> = Terminal<T> | Rules<T> | (()=>Rules<T>) | Ref<T> | Action<T, C, ValuesOfR<A>>;
type ValuesOfR<T extends readonly unknown[]> = { [K in keyof T]: ElemValue<T[K]> };
/*
export function RuleR<T, C, S1 extends RSymR<T, [], C>>(s1: S1): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends RSymR<T, [S1], C>>(s1: S1, s2: S2): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends RSymR<T, [S1, S2], C>>(s1: S1, s2: S2, s3: S3): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends RSymR<T, [S1, S2, S3], C>>(s1: S1, s2: S2, s3: S3, s4: S4): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends RSymR<T, [S1, S2, S3, S4], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends RSymR<T, [S1, S2, S3, S4, S5], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends RSymR<T, [S1, S2, S3, S4, S5, S6], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8], C>, S10 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8, S9], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9, s10: S10): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8], C>, S10 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8, S9], C>, S11 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9, s10: S10, s11: S11): Rule<T>;
export function RuleR<T, C, S1 extends SymR<[], C>, S2 extends SymR<[S1], C>, S3 extends SymR<[S1, S2], C>, S4 extends SymR<[S1, S2, S3], C>, S5 extends SymR<[S1, S2, S3, S4], C>, S6 extends SymR<[S1, S2, S3, S4, S5], C>, S7 extends SymR<[S1, S2, S3, S4, S5, S6], C>, S8 extends SymR<[S1, S2, S3, S4, S5, S6, S7], C>, S9 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8], C>, S10 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8, S9], C>, S11 extends SymR<[S1, S2, S3, S4, S5, S6, S7, S8, S9, S10], C>, S12 extends RSymR<T, [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11], C>>(s1: S1, s2: S2, s3: S3, s4: S4, s5: S5, s6: S6, s7: S7, s8: S8, s9: S9, s10: S10, s11: S11, s12: S12): Rule<T>;

export function RuleR(...syms: any[]): any {
	const last = syms.at(-1);
	if (typeof last === 'function' && last.length > 0)
		return Rule(syms.slice(0, -1), last);
	return Rule(syms, (values: any[]) => values[values.length - 1]);
}
*/
export function WithPrec<T>(rule: Rule<T>, prec: Precedence): Rule<T> {
	return {...rule, prec};
}

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
	function boundRule(...syms: any) { return RuleR(syms); }
	return boundRule;
}
export const RuleR = makeRuleR<any>();


export type Rules<T> = Rule<T>[]

export function Rules<T>(...alts: Rules<T>): Rules<T> {
	return alts;
}
export function RRules<T>(builder: (self: () => Rules<T>) => Rules<T>): Rules<T> {
	const rules: Rules<T> = builder(() => rules);
	return rules;
}

// A self-recursive rule set that allows the current rules to be referenced as `self`
export function CRules<T>(builder: (self: () => Rules<T>) => Rules<T>): Rules<T>;
export function CRules<T>(...alts: Rules<T>): Rules<T>;
export function CRules<T>(...args: [(self: () => Rules<T>) => Rules<T>] | Rules<T>): Rules<T> {
	if (args.length === 1 && typeof args[0] === 'function') {
		const rules = args[0](() => rules);
		return rules;
	}
	return args as Rules<T>;
}

export function List<T>(single: Rules<T> | (()=>Rules<T>), sep?: Sym) {
	return RRules<T[]>(self => [
		Rule([single] as const,	$ => [$[0]]),
		sep
			? Rule([self, sep, single] as const,	$ => [...($[0] as T[]), $[2]])
			: Rule([self, single] as const,			$ => [...($[0] as T[]), $[1]])
	]);
}
export function OneOf<T extends string>(names: readonly T[]) {
	return Rules(...names.map(name => Rule([name])));
}

export type TermLike = RegExp | string | Terminal;
export type MergeFn = (left: unknown, right: unknown) => unknown;

export interface GrammarSpec {
	precedence?:	Record<string, Assoc | PrecEntry>;
	start?:			Rules<any>;		// defaults to the first value of `rules`
	rules?:			Record<string, Rules<any>>;
	skip?:			TermLike[];
	terminals?:		TermLike[];
	recover?:		RecoveryCallback;
}

export interface Parser {
	parse(input: string, ctx?: any): unknown;
	tables: ParseTables;
}

// ===================================================================
//  Internal representation
// ===================================================================

class NonTerminal {
	constructor(public name: string) {}
}

type InternalSym = Terminal | NonTerminal;

const EOF		= new Terminal('$end');
const ERROR		= new Terminal('$error');
const ACCEPT	= new NonTerminal('$accept');

export interface InternalRule {
	id:			number;
	lhs:		NonTerminal;
	rhs:		InternalSym[];
	action: 	Action<unknown>;
	prec?:		PrecEntry;
	peek?:		number;		// extra preceding stack values to pass to `action` without popping them (mid-rhs actions: values of the symbols before them in the containing rule)
}

export type ActionEntry =
	| { kind: 'shift';	state:	number }
	| { kind: 'reduce'; rule:	number }
	| { kind: 'accept' }
	| { kind: 'ignore' }
	| { kind: 'error' }
	| { kind: 'conflict'; entries: ActionEntry[] }

export interface ConflictReport {
	state:		number;
	term:		Terminal;
	kind:		'auto' | 'shift-reduce' | 'reduce-reduce' | 'conflict';
	resolution: string;
}
export interface ParseTables {
	action: 	Map<Terminal, ActionEntry>[];		// indexed by state
	goto:		Map<NonTerminal, number>[];			// indexed by state
	rules:		InternalRule[];
	conflicts:	ConflictReport[];
}

// ===================================================================
//  Grammar builder
// ===================================================================

export class GrammarBuilder {
	rules:				InternalRule[] = [];
	alwaysTerminals:	Terminal[] = [];
	alwaysSkip:			Terminal[] = [];
	terminalsByName	= new Map<string, Terminal>();

	private first	= new Map<InternalSym, { terms: Set<Terminal>; nullable: boolean }>();
	private startSymbol: NonTerminal;

	constructor(spec: GrammarSpec) {
		const rules = [
			...(spec.start ? [spec.start] : []),
			...(spec.rules ? Object.values(spec.rules): [])
		];
		if (!rules.length)
			throw new Error('No rules defined in grammar spec');

		const nonTerminalsByName	= new Map(Object.keys(spec.rules ?? {}).map(name => [name, new NonTerminal(name)]));
		const nonTerminalsByRules	= new Map(Object.entries(spec.rules ?? {}).map(([name, nt]) => [nt, nonTerminalsByName.get(name)!]));

		if (spec.start && !nonTerminalsByRules.get(spec.start))
			nonTerminalsByRules.set(spec.start, new NonTerminal('start'));

		const internByRules	= (r: Rules<any>) => {
			let nt = nonTerminalsByRules.get(r);
			if (!nt) {
				nt = new NonTerminal('unknown name');
				nonTerminalsByRules.set(r, nt);
				rules.push(r);
			}
			return nt;
		};

		const internTerminal	= (name: string, re: RegExp): Terminal =>
			this.terminalsByName.get(name) ?? addTerminal(new Terminal(name, re));

		const addTerminal 		= (term: Terminal): Terminal => {
			if (nonTerminalsByName.has(term.name))
				throw `${term.name} used as terminal and nonterminal`;
			this.terminalsByName.set(term.name, term);
			return term;
		};

		const internTermLike = (s: TermLike) =>
			typeof(s) === 'string' ? internTerminal(s, new RegExp(literalPattern(s))) : s instanceof RegExp ? internTerminal(s.source, s) : addTerminal(s);

		const anon = (action: Action<any>, peek: number) => {
			const id	= this.rules.length;
			const lhs	= new NonTerminal(`anon ${id}`);

			this.first.set(lhs, { terms: new Set(), nullable: false });
			this.rules.push({
				id,
				lhs,
				rhs:	[],
				action,
				peek,
			});
			return lhs;
		};

		// -- Precedence -----------------------------------------------

		const prec	= new Map<string, PrecEntry>();
		if (spec.precedence) {
			let i = 0;
			for (const [name, val] of Object.entries(spec.precedence)) {
				if (typeof val !== 'string' && val.level)
					i = val.level;
				prec.set(name, { level: i++, assoc: typeof val === 'string' ? val : val.assoc });
			}
		}

		// -- provided terminals ------------------------------------
		for (const s of spec.terminals ?? [])
			this.alwaysTerminals.push(internTermLike(s));

		// -- Skip (whitespace/comments) ------------------------------------
		for (const s of spec.skip ?? [])
			this.alwaysSkip.push(internTermLike(s));

		// -- Augmented start rule -------------------------------------
		this.startSymbol = internByRules(rules[0])!;

		this.rules.push({
			id:		0,
			lhs:	ACCEPT,
			rhs:	[this.startSymbol, EOF],
			action: v => v[0],
		});

		// -- Discover non-terminals -----------------------------------

		const resolveSym = (sym: Sym, i: number) =>
			typeof sym === 'string'		? nonTerminalsByName.get(sym) ?? internTerminal(sym, new RegExp(literalPattern(sym)))
			: typeof sym === 'function'	? (has0args(sym) ? internByRules(sym()) : anon(sym, i))
			: sym instanceof RegExp		? internTerminal(sym.source, sym)
			: sym instanceof Terminal	? this.terminalsByName.get(sym.name) ?? addTerminal(sym)
//			: 'ref' in sym				? (typeof sym.ref === 'string' ? nonTerminalsByName.get(sym.ref) : internByRules(sym.ref()))
			: 'ref' in sym				? nonTerminalsByName.get(sym.ref)!
			: internByRules(sym)!;

		for (const r of rules) {
			const lhs = nonTerminalsByRules.get(r)!;
			for (const alt of r) {
				if (Array.isArray(alt)) {
					const nt = internByRules(alt);
					this.rules.push({
						id:		this.rules.length,
						lhs,
						rhs:	[nt],
						action:	(values: any[]) => values[0],
					});
				} else {
					const rhs = alt.rhs.map(resolveSym);
					this.rules.push({
						id:		this.rules.length,
						lhs,
						rhs,
						action:	alt.action ?? ((values: any[]) => values[0]),
						prec:	alt.prec === undefined ? undefined : typeof alt.prec === 'string' ? prec.get(alt.prec) : alt.prec,
					});
				}
			}
		}

		// -- FIRST sets ---------------------------------------------------

		for (const t of this.terminalsByName.values())
			this.first.set(t, { terms: new Set([t]), nullable: false });
		this.first.set(EOF, { terms: new Set([EOF]), nullable: false });
		for (const nt of nonTerminalsByRules.values())
			this.first.set(nt, { terms: new Set(), nullable: false });
		this.first.set(ACCEPT, { terms: new Set(), nullable: false });

		for (let changed = true; changed;) {
			changed = false;
			for (const rule of this.rules) {
				const first = this.first.get(rule.lhs)!;
				let allDeriveEps = true;
				for (const sym of rule.rhs) {
					const symFirst = this.first.get(sym)!;
					for (const f of symFirst.terms) {
						if (!first.terms.has(f)) {
							first.terms.add(f);
							changed = true;
						}
					}
					if (!symFirst.nullable) {
						allDeriveEps = false;
						break;
					}
				}
				if (allDeriveEps && !first.nullable) {
					first.nullable = true;
					changed = true;
				}
			}
		}
	}

	// -- SLR(1) table construction -------------------------------------
	//
	// Builds the compact LR(0) automaton (items carry no per-state lookahead, so there's no canonical-LR(1) state explosion
	// Then assigns each reduce item's lookahead via the rule's plain FOLLOW(lhs) set rather than context-sensitive per-state lookaheads.
	// This is SLR(1), strictly weaker than true LALR(1): it can flag a few conflicts a context-sensitive LALR(1) table would have resolved without one.
	// Those still go through the same precedence/assoc resolution below, or the GLR fork/merge engine for genuine ambiguity -- so correctness isn't at risk, only how many conflicts get reported.

	buildTables(): ParseTables {
		interface LR0Item { rule: number; dot: number; }
		const lr0Key = (i: LR0Item) => `${i.rule}:${i.dot}`;

		const lr0Closure = (items: LR0Item[]): LR0Item[] => {
			const inSet = new Set(items.map(lr0Key));
			const queue = [...items];
			for (const { rule, dot } of queue) {
				const B = this.rules[rule].rhs[dot];
				if (B instanceof NonTerminal) {
					for (const prod of this.rules) {
						if (prod.lhs === B) {
							const ni	= { rule: prod.id, dot: 0 };
							const k		= lr0Key(ni);
							if (!inSet.has(k)) {
								inSet.add(k);
								queue.push(ni);
							}
						}
					}
				}
			}
			return queue;
		};

		const lr0Goto = (items: LR0Item[], sym: InternalSym) => {
			const moved = items
				.filter(i => this.rules[i.rule].rhs[i.dot] === sym)
				.map(i => ({ rule: i.rule, dot: i.dot + 1 }));
			return lr0Closure(moved);
		};

		const lr0SetKey = (items: LR0Item[]) => [...items].map(lr0Key).sort().join('|');

		// Build the LR(0) automaton
		const lr0States:	LR0Item[][] = [];
		const lr0Trans:		Map<InternalSym, number>[] = [];
		const lr0KeyToId	= new Map<string, number>();

		const addLR0State = (items: LR0Item[]): number => {
			const key = lr0SetKey(items);
			if (lr0KeyToId.has(key))
				return lr0KeyToId.get(key)!;
			const id = lr0States.length;
			lr0States.push(items);
			lr0KeyToId.set(key, id);
			return id;
		};

		addLR0State(lr0Closure([{ rule: 0, dot: 0 }]));

		for (let si = 0; si < lr0States.length; si++) {
			lr0Trans[si] = new Map();
			const syms = new Set(lr0States[si]
				.filter(i => i.dot < this.rules[i.rule].rhs.length)
				.map(i => this.rules[i.rule].rhs[i.dot]));
			for (const sym of syms) {
				const moved = lr0Goto(lr0States[si], sym);
				if (moved.length)
					lr0Trans[si].set(sym, addLR0State(moved));
			}
		}

		const numStates = lr0States.length;

		// -- FOLLOW sets (SLR(1) reduce lookaheads) ------------------------
		const follow = new Map<NonTerminal, Set<Terminal>>();
		for (const nt of new Set(this.rules.map(r => r.lhs)))
			follow.set(nt, new Set());

		for (let changed = true; changed; ) {
			changed = false;
			for (const rule of this.rules) {
				for (let i = 0; i < rule.rhs.length; i++) {
					const sym = rule.rhs[i];
					if (sym instanceof Terminal)
						continue;
					const followSym = follow.get(sym)!;

					let restNullable = true;
					for (let j = i + 1; j < rule.rhs.length; j++) {
						const sf = this.first.get(rule.rhs[j])!;
						for (const f of sf.terms) {
							if (!followSym.has(f)) {
								followSym.add(f);
								changed = true;
							}
						}
						if (!sf.nullable) {
							restNullable = false;
							break;
						}
					}
					if (restNullable) {
						for (const f of follow.get(rule.lhs)!) {
							if (!followSym.has(f)) {
								followSym.add(f);
								changed = true;
							}
						}
					}
				}
			}
		}

		const shiftRule = Array.from({ length: numStates }, () => new Map<Terminal, InternalRule>());
		const action	= Array.from({ length: numStates }, () => new Map<Terminal, ActionEntry>());
		const goto		= Array.from({ length: numStates }, () => new Map<NonTerminal, number>());
		const conflicts: ConflictReport[]	= [];

		for (let s = 0; s < numStates; s++) {
			for (const item of lr0States[s]) {
				const r = this.rules[item.rule];
				if (item.dot < r.rhs.length) {
					const sym = r.rhs[item.dot];
					if (sym instanceof Terminal && !shiftRule[s].has(sym))
						shiftRule[s].set(sym, r);
				}
			}
			for (const [sym, target] of lr0Trans[s]) {
				if (sym instanceof Terminal)
					this.setAction(action[s], sym, sym === EOF ? { kind: 'accept' } : { kind: 'shift', state: target }, s, shiftRule[s].get(sym)?.prec, conflicts);
				else
					goto[s].set(sym, target);
			}
			for (const item of lr0States[s]) {
				const r = this.rules[item.rule];
				if (item.dot >= r.rhs.length && r.lhs !== ACCEPT)
					for (const la of follow.get(r.lhs)!)
						this.setAction(action[s], la, { kind: 'reduce', rule: item.rule }, s, shiftRule[s].get(la)?.prec, conflicts);
			}
			for (const term of this.alwaysTerminals) {
				if (!action[s].has(term))
					action[s].set(term, {'kind': 'error'} );
			}
			for (const term of this.alwaysSkip) {
				if (!action[s].has(term))
					action[s].set(term, {'kind': 'ignore'} );
			}
		}

		return {
			action,
			goto,
			rules:		this.rules,//.map(r => ({ lhs: r.lhs, rhsLen: r.rhs.length })),
			conflicts,
		};
	}

	// -- Conflict resolution (Bison rules) ---------------------------

	private setAction(
		row:		Map<Terminal, ActionEntry>,
		term:		Terminal,
		incoming:	ActionEntry,
		state:		number,
		//shiftRuleId: number | undefined,
		shiftPrec:	PrecEntry | undefined,
		conflicts:	ConflictReport[]
	) {
		if (!row.has(term)) {
			row.set(term, incoming);
			return;
		}
		const existing = row.get(term)!;
		if (
			(existing.kind === 'shift' && incoming.kind === 'reduce') ||
			(existing.kind === 'reduce' && incoming.kind === 'shift')
		) {
			const shiftEntry	= (existing.kind === 'shift'	? existing : incoming) as { kind: 'shift';	state:	number };
			const reduceEntry	= (existing.kind === 'reduce'	? existing : incoming) as { kind: 'reduce';	rule:	number };
			// Precedence belongs to rules: compare the reducing rule's level against
			// the level of whichever rule is about to shift this lookahead token.
			//const shiftPrec		= shiftRuleId !== undefined ? this.rules[shiftRuleId].prec : undefined;
			const reducePrec	= this.rules[reduceEntry.rule].prec;

			if (reducePrec?.assoc === 'fork' || shiftPrec?.assoc === 'fork') {
				row.set(term, {kind: 'conflict', entries: [shiftEntry, reduceEntry]});
				conflicts.push({ state, term, kind: 'conflict', resolution: 'use GLR (fork)' });
			} else if (shiftPrec !== undefined && reducePrec !== undefined) {
				if (reducePrec.level! > shiftPrec.level!) {
					row.set(term, reduceEntry);
					conflicts.push({ state, term, kind: 'shift-reduce', resolution: 'reduce (reduce-rule prec > shift-rule prec)' });
				} else if (reducePrec.level! < shiftPrec.level!) {
					row.set(term, shiftEntry);
					conflicts.push({ state, term, kind: 'shift-reduce', resolution: 'shift (shift-rule prec > reduce-rule prec)' });
				} else if (shiftPrec.assoc === 'left') {
					row.set(term, reduceEntry);
					conflicts.push({ state, term, kind: 'shift-reduce', resolution: 'reduce (left assoc)' });
				} else if (shiftPrec.assoc === 'right') {
					row.set(term, shiftEntry);
					conflicts.push({ state, term, kind: 'shift-reduce', resolution: 'shift (right assoc)' });
				} else {
					row.set(term, {kind: 'conflict', entries: [shiftEntry, reduceEntry]});
					conflicts.push({ state, term, kind: 'conflict', resolution: 'use GLR' });
				}
			} else {
				row.set(term, shiftEntry);
				conflicts.push({ state, term, kind: 'auto', resolution: 'shift (default, no prec info)' });
			}

		} else if (existing.kind === 'reduce' && incoming.kind === 'reduce') {
			if (this.rules[existing.rule].prec?.assoc === 'fork' || this.rules[incoming.rule].prec?.assoc === 'fork') {
				row.set(term, {kind: 'conflict', entries: [existing, incoming]});
				conflicts.push({ state, term, kind: 'conflict', resolution: 'use GLR (fork)' });
			} else {
				const winner = existing.rule < incoming.rule ? existing : incoming;
				row.set(term, winner);
				conflicts.push({ state, term, kind: 'reduce-reduce', resolution: `reduce by rule ${winner.rule} (earlier rule wins)` });
			}
		}
		// shift-shift / accept: keep existing (shouldn't occur in valid grammars)
	}
}

// ===================================================================
//  Parser runtime
// ===================================================================

function advancePos(state: TextPos, text: string) {
	for (const ch of text) {
		if (ch === '\n') {
			state.line++;
			state.col = 1;
			//console.log(state.line);
		} else {
			state.col++;
		}
	}
	state.offset += text.length;
	return state;
}

interface Lexer extends TextPos {
	prev?:		Token;
	next(allowed: Map<Terminal, ActionEntry>): 	Token;
	peekText(): string;
}

// Combines the values of two GLR derivation paths that have converged onto the same state+parent (see `runGlrFork`).
// Only consulted for reduce-driven convergence, keyed by the reducing rule's id (its index in `tables.rules`) --
// shift-driven convergence always uses `defaultMerge`, since both paths shifted the same literal token.
// Two forked paths that both survive to the same convergence point with an identical value aren't a real
// ambiguity to report -- they're the same parse reached two ways (e.g. a reduce-reduce `fork` between two
// rules that happen to build the same AST shape for a given input). Collapse those instead of accumulating
// an array, which downstream consumers would otherwise see instead of the plain value they expect.
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const defaultMerge: MergeFn = (left, right) => {
	if (Array.isArray(left))
		return left.some(v => sameValue(v, right)) ? left : [...left, right];
	return sameValue(left, right) ? left : [left, right];
};

function nextToken(allowed: Map<Terminal, ActionEntry>, input: string, state: TextPos & { lastShifted?: Token }, ctx: any, resolveSym: (sym: string|RegExp|Terminal|undefined) => Terminal|undefined): Token {

	while (state.offset < input.length) {
		const candidates: { term: Terminal; len: number }[] = [];
		for (const term of allowed.keys()) {
			const re = term.pattern;
			if (re) {
				re.lastIndex = state.offset;
				const m = re.exec(input);
				if (m && (m[0].length > 0 || allowed.get(term)?.kind !== 'ignore'))
					candidates.push({ term, len: m[0].length });
			}
		}
		candidates.sort((a, b) => b.len - a.len
			|| (a.term.pattern!.source < b.term.pattern!.source ? 1 : a.term.pattern!.source > b.term.pattern!.source ? -1 : 0));

		let chosen:	{ term: Terminal; len: number } | undefined;
		for (const { term, len } of candidates) {
			let result: Terminal | undefined;
			if (!term.callback) {
				result = term;
			} else {
				const text = input.slice(state.offset, state.offset + len);
				const after = advancePos({...state}, text);
				result = resolveSym(term.callback({
					...state,
					prev:		state.lastShifted,
					match:		text,
					remaining:	input.substring(after.offset),
					next: 		() => nextToken(allowed, input, after, ctx, resolveSym),
				}, ctx));
			}
			if (result) {
				chosen = { term: result, len };
				break;
			}
		}

		if (!chosen)
			return { type: ERROR, value: input.substring(state.offset), pos: { offset: state.offset, line: state.line, col: state.col }};

		const matched	= input.slice(state.offset, state.offset + chosen.len);
		const token		= allowed.get(chosen.term)?.kind !== 'ignore'
			? { type: chosen.term, value: matched, pos: { offset: state.offset, line: state.line, col: state.col } }
			: null;

		advancePos(state, matched);

		if (token)
			return token;
	}
	return { type: EOF, value: '', pos: { offset: state.offset, line: state.line, col: state.col }};
}

interface StackEntry { state: number; value: unknown; }

function dumpStack(stack: readonly StackEntry[]) {
	console.error('Stack dump:');
	for (let i = 0; i < stack.length; i++)
		console.error(`${'  '.repeat(i)}state: ${stack[i].state}, value: ${JSON.stringify(stack[i].value)}`);
}

function recoverCtx(stream: Lexer): LexPosition {
	return { offset: stream.offset, line: stream.line, col: stream.col, remaining: stream.peekText(), prev: stream.prev };
}

function runParser(tables: ParseTables, stream: Lexer, ctx: any, recover: RecoveryCallback | undefined, mergeFns: Record<number, MergeFn> = {}) {
	const stack: StackEntry[] = [{ state: 0, value: undefined }];

	let realTok		= stream.next(tables.action[0]);

	// A `recover`-synthesized token (e.g. ASI's phantom `;`) never consumes `realTok` itself -- only a
	// genuine shift/reduce of `realTok` (or the lexer producing a fresh one) advances `stream.offset`.
	// If recovery keeps firing at the *same* offset well beyond what any legitimate multi-step recovery
	// cascade should need, it's re-synthesizing against the exact same real token that's still sitting
	// there unconsumed: an infinite loop (recovery keeps "fixing" the parse by inserting more phantom
	// tokens, but the actual unexpected input is never shifted or reported). The bound is generous (not
	// 1) since a single stuck token can legitimately need a few recovery-driven reduces before it's
	// finally shift-able, just never anywhere near this many. Found via real files ending in an unmatched
	// `}` and via `binary-archives/test/test_tar.ts`'s unterminated trailing comment (a different trigger
	// of the same underlying gap, before the lexer fix for that -- kept as a backstop here in case another
	// trigger exists).
	let recoveryStuckAt: number | undefined;
	let recoveryStuckCount = 0;
	const MAX_RECOVERY_AT_SAME_OFFSET = 50;

	while (true) {
		const row			= tables.action[stack[stack.length - 1].state];
		const direct		= row.get(realTok.type);
		const usingRecovery	= !direct || direct.kind === 'error';
		if (usingRecovery) {
			// Deliberately NOT reset when `usingRecovery` is false: a stuck cycle typically alternates
			// recovery steps with genuine direct shift/reduce steps *of the synthesized token itself*
			// (e.g. shift the phantom `;`, reduce it into an empty statement, hit recovery again) --
			// resetting on every non-recovery step means the counter never accumulates, since it's rare
			// to see two recovery steps in a row even when truly stuck. `stream.offset` only advances
			// when `realTok` itself is genuinely consumed, so comparing against it (not against "was the
			// previous step recovery") is what actually detects "no real progress since recovery started".
			recoveryStuckCount = recoveryStuckAt === stream.offset ? recoveryStuckCount + 1 : 1;
			recoveryStuckAt = stream.offset;
			if (recoveryStuckCount > MAX_RECOVERY_AT_SAME_OFFSET) {
				dumpStack(stack);
				const pos = recoverCtx(stream);
				throw new SyntaxError(
					`Parser stuck in error recovery at line ${pos.line}, col ${pos.col} `
					+ `(recovery keeps re-inserting a token without consuming '${realTok.type.name}') -- this is a parser/grammar bug, not just invalid input.`
				);
			}
		}
		const tok			= usingRecovery ? recover?.(recoverCtx(stream), row) : realTok;
		const entry			= tok && row.get(tok.type);

		if (!entry || entry.kind === 'error') {
			dumpStack(stack);
			const expected	= [...row].filter(([k, v]) => k !== EOF && v.kind !== 'error').map(([k]) => k.name);
			const pos		= recoverCtx(stream);
			throw new SyntaxError(
				(realTok.type !== ERROR ? `Unexpected token '${realTok.type.name}'` : `Unexpected character '${pos.remaining[0] ?? ''}'`)
				+ ` at line ${pos.line}, col ${pos.col}. `
				+ `Expected: ${expected.length ? expected.join(', ') : '(nothing)'}`
			);
		}

		if (entry.kind === 'conflict') {
			const result = runGlrFork(tables, stream, tok, ctx, mergeFns, recover, stack);
			if (result)
				return result.value;
			realTok = stream.next(tables.action[stack[stack.length - 1].state]);

		} else if (entry.kind === 'shift') {
			stack.push({ state: entry.state, value: tok.value });
			if (tok === realTok) {
				stream.prev = realTok;
				realTok = stream.next(tables.action[entry.state]);
			} else if (realTok.type === ERROR) {
				realTok = stream.next(tables.action[entry.state]);
			}

		} else if (entry.kind === 'reduce') {
			const rule		= tables.rules[entry.rule];
			const rhsLen	= rule.rhs.length;
			const peek		= rule.peek ?? 0;
			const vals		= [
				...(peek ? stack.slice(stack.length - rhsLen - peek, stack.length - rhsLen).map(e => e.value) : []),
				...stack.splice(stack.length - rhsLen, rhsLen).map(e => e.value)
			];

			const topState	= stack[stack.length - 1].state;
			const state = tables.goto[topState].get(rule.lhs);
			if (state === undefined)
				throw new Error(`No GOTO entry for state ${topState}, non-terminal '${rule.lhs.name}'`);

			const value = rule.action(vals, ctx);
			//console.log(`${'  '.repeat(stack.length)}${rule.lhs.name} -> ${rule.rhs.map(r => r.name).join(' ')}, made: ${JSON.stringify(value)}`);
			stack.push({ state, value });

		} else if (entry.kind === 'accept') {
			return stack[stack.length - 1].value;

		} else {
			// 'error' is filtered out above; 'ignore' tokens are never returned by the lexer.
			throw new Error(`Internal error: unexpected action kind '${entry.kind}'`);
		}
	}
}


// ===================================================================
//  GLR fork explorer
// ===================================================================

type GlrForkResult = { accepted: true; value: unknown } | undefined;

// On a non-accepting return, `stack` has been overwritten in place with the settled single derivation.
function runGlrFork(
	tables: ParseTables, stream: Lexer, tok: Token, ctx: any, mergeFns: Record<number, MergeFn>, recover: RecoveryCallback | undefined,
	stack: StackEntry[],
): GlrForkResult {

	interface StackFrame {
		id:		number;			// identifies this exact frame, for convergence keys below
		parent: StackFrame | null;
		state:	number;
		value:	unknown;
	}

	let frameIdCounter	= 0;
	let accepted		= false;
	let acceptedValue: unknown;

	const makeFrame		= (parent: StackFrame | null, state: number, value: unknown) => ({ id: frameIdCounter++, parent, state, value });
	const convergeKey	= (top: StackFrame) => `${top.state}:${top.parent ? top.parent.id : -1}`;
	const mergeInto		= (into: StackFrame, incoming: StackFrame, ruleId?: number) =>
		makeFrame(into.parent, into.state, ((ruleId !== undefined ? mergeFns[ruleId] : undefined) ?? defaultMerge)(into.value, incoming.value));

	// Flat stack -> frame chain
	let frame = makeFrame(null, stack[0].state, undefined);
	for (let i = 1; i < stack.length; i++)
		frame = makeFrame(frame, stack[i].state, stack[i].value);

	let active = new Map([[convergeKey(frame), frame]]);

	// General circuit breaker on top of the recovery-specific one further down: bounds *all* work done
	// across this whole call (every dequeue from every position's worklist), not just recovery-driven
	// re-registrations at a single position. Catches runaway path explosion from any cause -- genuine
	// grammar ambiguity gone combinatorial, not just the "recovery never converges" pattern the more
	// specific check below targets -- since a real GLR fork resolving a small, deliberate ambiguity
	// (the handful of `forceFork`-tagged rules in this codebase) never needs anywhere near this many.
	let totalWork = 0;
	const MAX_TOTAL_WORK = 5_000;

	for (let i = 0; ; i++) {
		const worklist	= [...active.values()];
		const shifted: StackFrame[] = [];	// frames shifted to position i + 1, to be merged there

		// Register a freshly-produced same-position frame merging with whatever's already live at that state+parent.
		const registerAtPosition = (newTop: StackFrame, ruleId?: number) => {
			const key		= convergeKey(newTop);
			const existing	= active.get(key);
			const top		= existing ? mergeInto(existing, newTop, ruleId) : newTop;
			active.set(key, top);
			worklist.push(top);
		};

		const applyAction = (path: StackFrame, entry: ActionEntry, actionTok: Token, stayAtSamePosition: boolean) => {
			if (entry.kind === 'shift') {
				const top = makeFrame(path, entry.state, actionTok.value);
				if (stayAtSamePosition)
					registerAtPosition(top);
				else
					shifted.push(top);

			} else if (entry.kind === 'reduce') {
				const	rule	= tables.rules[entry.rule];
				const	peek	= rule.peek ?? 0;
				let		top		= path;
				let		n		= rule.rhs.length;
				const vals: unknown[] = new Array(n + peek);
				while (n--) {
					vals[peek + n]	= top.value;
					top				= top.parent!;
				}
				let peekFrame = top;
				for (let m = peek; m--; ) {
					vals[m]		= peekFrame.value;
					peekFrame	= peekFrame.parent!;
				}
				const reducedValue	= rule.action(vals, ctx);
				const nextState		= tables.goto[top.state]?.get(rule.lhs);
				if (nextState !== undefined)
					registerAtPosition(makeFrame(top, nextState, reducedValue), entry.rule);

			} else {//if (entry.kind === 'accept') {
				acceptedValue = path.value;
				accepted = true;
			}
		};

		// Same infinite-loop hazard `runParser`'s own recovery-stuck check guards against (see there for the
		// full explanation), just shaped differently here: a recovery-synthesized token can `registerAtPosition`
		// (push back onto this *same* worklist) instead of advancing to `shifted`, so a recovery that never
		// converges toward actually consuming `tok` can churn this loop forever without ever growing `i` or
		// exhausting the worklist naturally. Bounded generously -- legitimate wide ambiguity can process many
		// paths per position, but not via recovery specifically, repeatedly, at a single frozen `tok`.
		let recoveryUsedCount = 0;
		const MAX_RECOVERY_PER_POSITION = 200;

		while (worklist.length > 0 && !accepted) {
			if (++totalWork > MAX_TOTAL_WORK) {
				const pos = recoverCtx(stream);
				throw new SyntaxError(
					`GLR fork exceeded ${MAX_TOTAL_WORK} total steps resolving ambiguity at line ${pos.line}, col ${pos.col} `
					+ `-- likely runaway path explosion, not genuine ambiguity (this is a parser/grammar bug, not just invalid input).`
				);
			}
			const path	= worklist.shift()!;
			// A frame superseded by a later merge at the same key is a dead end: skip it, since the merged successor (already on the worklist) carries the real value.
			if (active.get(convergeKey(path)) !== path)
				continue;

			const row			= tables.action[path.state];
			const direct		= row.get(tok.type);
			const usingRecovery	= !direct || direct.kind === 'error';
			if (usingRecovery && ++recoveryUsedCount > MAX_RECOVERY_PER_POSITION) {
				const pos = recoverCtx(stream);
				throw new SyntaxError(
					`GLR fork stuck in error recovery at line ${pos.line}, col ${pos.col} `
					+ `(recovery keeps re-inserting a token without consuming '${tok.type.name}') -- this is a parser/grammar bug, not just invalid input.`
				);
			}
			const actionTok		= usingRecovery ? recover?.(recoverCtx(stream), row) : tok;
			const entry			= actionTok && row.get(actionTok.type);
			if (entry && entry.kind !== 'error') {
				if (entry.kind === 'conflict') {
					for (const inner of entry.entries)
						applyAction(path, inner, actionTok, actionTok != tok);
				} else {
					applyAction(path, entry, actionTok, actionTok != tok);
				}
			}
		}

		if (accepted)
			return { accepted: true, value: acceptedValue };

		if (tok.type === EOF)
			throw new SyntaxError('Parse completed without accept');

		if (tok.type !== ERROR)
			stream.prev = tok;

		// Merge converging paths landing on i + 1 (same derivation reached by separate shifts).
		if (!shifted.length)
			throw new SyntaxError(`No active parse paths at position ${i + 1}`);

		active = new Map<string, StackFrame>();
		for (const path of shifted) {
			const key		= convergeKey(path);
			const existing	= active.get(key);
			active.set(key, existing ? mergeInto(existing, path) : path);
		}

		// Settled back down to a single derivation -- hand it back to runParser's fast loop
		if (active.size === 1) {
			const frames: StackEntry[] = [];
			for (let frame: StackFrame | null = active.values().next().value!; frame; frame = frame.parent)
				frames.push({ state: frame.state, value: frame.value });
			stack.length = 0;
			for (let i = frames.length - 1; i >= 0; i--)
				stack.push(frames[i]);
			return;
		}

		// Still multiple derivations active -- a token valid for *any* of them is fair game, so the lexer restriction is their rows' union, not any single one's.
		const allowed = new Map<Terminal, ActionEntry>();
		for (const path of active.values())
			for (const [term, entry] of tables.action[path.state])
				allowed.set(term, entry);
		tok = stream.next(allowed);
	}
}

// ===================================================================
//  Main entry point
// ===================================================================

export function makeParser(spec: GrammarSpec,
	merge?:		Record<number, MergeFn>, 	// Merge functions for ambiguous convergence points. Key = rule id of the reducing rule (its index in tables.rules).
): Parser {
	const g			= new GrammarBuilder(spec);
	const tables	= g.buildTables();

	const resolveSym = (sym: string|RegExp|Terminal|undefined): Terminal|undefined =>
		typeof sym === 'string'		? g.terminalsByName.get(sym)
		: sym instanceof RegExp		? g.terminalsByName.get(sym.source)
		: sym;

	const makeLexer = (input: string, ctx: any) => ({
		offset:	0,
		line:	1,
		col:	1,
		next(allowed: Map<Terminal, ActionEntry>) { return nextToken(allowed, input, this, ctx, resolveSym); },
		peekText() { return input.substring(this.offset); }
	});

	return {
		tables,
		parse: (input, ctx) => runParser(tables, makeLexer(input, ctx), ctx, spec.recover ?? (()=>undefined), merge ?? {})
	};
}
