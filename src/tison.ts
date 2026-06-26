// tison.ts -- A TypeScript-object-based SLR(1)/GLR parser generator.
//
// Analogous to GNU Bison, but instead of parsing a .y file you pass a
// plain TypeScript object that describes your grammar. Terminals carry
// regex patterns, so tison is the lexer too -- you just feed it a string.
//
// Usage:
//
//   const NUMBER = /[0-9]+(?:[.][0-9]+)?/;
//   const PLUS   = /[+]/;
//   const MINUS  = /[-]/;
//   const STAR   = /[*]/;
//   const SLASH  = /[/]/;
//   const LPAREN = /[(]/;
//   const RPAREN = /[)]/;
//
//   const parser = tison({
//     skip: [/\s+/],
//     precedence: [
//       { assoc: 'left',  name: 'additive' },
//       { assoc: 'left',  name: 'multiplicative' },
//       { assoc: 'right', name: 'unary' },
//     ],
//     start: 'expr',
//     rules: {
//       expr: [
//         { rhs: ['expr', PLUS,  'expr'], action: ($) => $[0] + $[2], prec: 'additive' },
//         { rhs: ['expr', MINUS, 'expr'], action: ($) => $[0] - $[2], prec: 'additive' },
//         { rhs: ['expr', STAR,  'expr'], action: ($) => $[0] * $[2], prec: 'multiplicative' },
//         { rhs: ['expr', SLASH, 'expr'], action: ($) => $[0] / $[2], prec: 'multiplicative' },
//         { rhs: [MINUS, 'expr'],         action: ($) => -$[1], prec: 'unary' },
//         { rhs: [LPAREN, 'expr', RPAREN], action: ($) => $[1] },
//         { rhs: [NUMBER], action: ($) => parseFloat($[0] as string) },
//       ],
//     },
//   });
//
//   console.log(parser.parse('3 + 4 * 5'));   // 23
//
// A token is just a RegExp -- reuse the same pattern (by source text) everywhere it's referenced and tison treats it as one terminal, auto-naming it internally.
// A plain string in `rhs` is a non-terminal if some rule's `lhs` uses that name, otherwise it's sugar for a terminal matching that literal text (e.g. '+' instead of /[+]/).
//
// Precedence belongs to rules, not tokens:
// `precedence` declares named levels (lowest to highest); rules opt in via `prec`, and a shift/reduce conflict is resolved by comparing the reducing rule's level against the level of whichever rule wants to shift instead.

// ===================================================================
//  Public API types
// ===================================================================

// utility
//
// A literal that ends in a word character (e.g. 'var', 'in') is given an implicit trailing word-boundary, so it can never match as a strict prefix of a longer word
export function literalPattern(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w/.test(s[s.length - 1]) ? '(?!\\w)' : '');
}

export function List<T>(single: Rules<T> | (()=>Rules<T>), sep?: string) {
	return Rules<T[]>(self => [
		Rule([single] as const,	$ => [$[0]]),
		sep
			? Rule([self, sep, single] as const,	$ => [...($[0] as T[]), $[2]])
			: Rule([self, single] as const,			$ => [...($[0] as T[]), $[1]])
	]);
}

interface Ref<T> { ref: string; }
export function Ref<T>(s: string): Ref<T> {
	return {ref: s};
}

export function Forward<T>(f: () => any) {
	return f as (() => Rules<T>);
}
export interface TextPos {
	offset: number; line: number; col: number;
}
export interface LexState extends TextPos {
	prev?:	Terminal;	// the most recently returned non-ignored terminal -- feeds LexContext.prev
}


// Context given to a terminal's `lex` callback once its pattern has matched at the current position.
// The callback decides what (if anything) this match actually is:
//   - return undefined to reject the match (it won't compete this round, so a shorter match from a different terminal can win instead)
//   - return the terminal itself to accept it normally
//   - return a different terminal to reclassify the match as that instead
// `peekNext` looks past this match non-destructively, for terminals (like whitespace) that need to know what's coming to decide how to classify themselves
export interface LexContext extends LexState {
	text:		string;
	ctx?:		any;
	peekNext:	() => Token | null;
	peekText:	() => string;
}

export type LexCallback = (ctx: LexContext) => Terminal | string | RegExp | undefined;

export class Terminal<T = string> {
	ignore = false;
	pattern?: RegExp;
	constructor(public name: string, pattern?: RegExp, public lex?: LexCallback) {
		if (pattern)
			this.pattern = new RegExp(pattern.source, 'y' + pattern.flags.replace(/[gyd]/g, ''));
	}
}

export function termOneOf<T extends string>(names: readonly T[]) {
	return new Terminal<T>(names.join('|'), RegExp(names.map(literalPattern).join('|')));
}

export function terminal(name: string, pattern?: RegExp, lex?: LexCallback) {
	return new Terminal(name, pattern, lex);
}

export type Rules<T> = Rule<T, any>[]
type Action<T, A = unknown[]> = (values: A, ctx?: any) => T
type Sym = string | RegExp | Terminal | Rules<any> | (()=>Rules<any>) | Ref<any> | Action<any>;

type ElemValue<S> = S extends Rule<infer U, any>[] ? U
	: S extends RegExp ? string
	: S extends Terminal<infer U> ? U
	: S extends (()=>infer U) ? ElemValue<U>
	: S extends Ref<infer U> ? U
	: S extends string ? S
	: S extends Action<any, infer U> ? U
	: unknown;

type ValuesOf<T extends readonly Sym[]> = {[K in keyof T]: ElemValue<T[K]>}

export interface Rule<T, R extends readonly Sym[]> {
	rhs:		R;
	action?:	(values: ValuesOf<R>, ctx?: any) => T;
	prec?:		string;
}
export type ValueOf<R> = R extends Rule<infer T, any>[] ? T : never;

export function Rule<T, R extends readonly Sym[]>(rhs: R, action?: Action<T, ValuesOf<R>>, prec?: string): Rule<T, R> {
	return { rhs, action, prec };
}

// A self-recursive rule set (e.g. `Rule(['delete', X], ...)` where X means "another one of these") needs *some* reference to itself while it's still being built.
// The builder-callback overload hands that back for free as `self`, typed correctly with no circular-inference workaround needed at the call site
export function Rules<T>(builder: (self: () => Rules<T>) => Rules<T>): Rules<T>;
export function Rules<T>(...alts: Rules<T>): Rules<T>;
export function Rules<T>(...args: [(self: () => Rules<T>) => Rules<T>] | Rules<T>): Rules<T> {
	if (args.length === 1 && typeof args[0] === 'function') {
		const rules = args[0](() => rules);
		return rules;
	}
	return args as Rules<T>;
}

type Assoc = 'left' | 'right' | 'nonassoc';
export interface Precedence {
	name:		string;
	assoc:		Assoc;
}

export interface GrammarSpec {
	skip?:			(RegExp | Terminal)[];
	precedence?:	Record<string, Assoc>;
	start?:			Rules<any>;		// defaults to the first value of `rules`
	rules?:			Record<string, Rules<any>>;
	recover?: (row: Map<Terminal, ActionEntry>, token: Token, prevToken: Token | undefined) => Token | undefined;
}

export interface Parser {
	parse(input: string, ctx?: any): unknown;
	tables: ParseTables;
}

// ===================================================================
//  Internal representation
// ===================================================================

export class NonTerminal {
	constructor(public name: string) {}
}

export type InternalSym = Terminal | NonTerminal;

export const EOF	= new Terminal('$end');
export const ACCEPT	= new NonTerminal('$accept');

interface PrecEntry {
	level:		number;
	assoc:		Assoc;
}

export interface InternalRule {
	id:			number;
	lhs:		NonTerminal;
	rhs:		InternalSym[];
	action: 	(values: readonly unknown[], ctx?: any) => unknown;
	prec?:		PrecEntry;
}

export type ActionEntry =
	| { kind: 'shift';	state:	number }
	| { kind: 'reduce'; rule:	number }
	| { kind: 'accept' }
	| { kind: 'conflict'; entries: ActionEntry[] }

export interface ConflictReport {
	state:		number;
	term:		Terminal;
	kind:		'shift-reduce' | 'reduce-reduce' | 'conflict';
	resolution: string;
}
export interface ParseTables {
	action: 	Map<Terminal, ActionEntry>[];		// indexed by state
	goto:		Map<NonTerminal, number>[];			// indexed by state
//	rules:		{ lhs: NonTerminal; rhsLen: number }[];
	rules:		InternalRule[];
	conflicts:	ConflictReport[];
}

// ===================================================================
//  Grammar builder
// ===================================================================

function has0args<T>(fn: (arg: any) => T): fn is ()=>T {
	return fn.length === 0;
}

export class GrammarBuilder {
	rules:		InternalRule[] = [];
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

		const anon = (action: Action<any, any>) => {
			const id	= this.rules.length;
			const lhs	= new NonTerminal(`anon ${id}`);

			this.first.set(lhs, { terms: new Set(), nullable: false });
			this.rules.push({
				id,
				lhs,
				rhs:	[],
				action
			});
			return lhs;
		};

		// -- Precedence -----------------------------------------------
		// Levels are pure named abstractions -- rules opt into one via `prec`.

		const prec	= new Map<string, PrecEntry>();
		if (spec.precedence) {
			Object.entries(spec.precedence).forEach(([name, assoc], i) => {
				prec.set(name, { level: i, assoc: assoc });
			});
		}

		// -- Skip (whitespace/comments) ------------------------------------
		for (const s of spec.skip ?? [])
			(s instanceof RegExp ? internTerminal(s.source, s) : addTerminal(s)).ignore = true;

		// -- Augmented start rule -------------------------------------
		this.startSymbol = internByRules(rules[0])!;

		this.rules.push({
			id:		0,
			lhs:	ACCEPT,
			rhs:	[this.startSymbol, EOF],
			action: v => v[0],
		});

		// -- Discover non-terminals -----------------------------------

		const resolveSym = (sym: Sym) =>
			typeof sym === 'string'		? nonTerminalsByName.get(sym) ?? internTerminal(sym, new RegExp(literalPattern(sym)))
			: typeof sym === 'function'	? (has0args(sym) ? internByRules(sym()) : anon(sym))
			: sym instanceof RegExp		? internTerminal(sym.source, sym)
			: sym instanceof Terminal	? this.terminalsByName.get(sym.name) ?? addTerminal(sym)
			: 'ref' in sym				? nonTerminalsByName.get(sym.ref)
			: internByRules(sym)!;

		for (const r of rules) {
			const lhs = nonTerminalsByRules.get(r)!;
			for (const alt of r) {
				const rhs = alt.rhs.map(resolveSym);
				this.rules.push({
					id:		this.rules.length,
					lhs,
					rhs,
					action:	alt.action ?? ((() => undefined) as any),
					prec:	alt.prec !== undefined ? prec.get(alt.prec) : undefined,
				});
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
				const r = this.rules[rule];
				if (dot >= r.rhs.length)
					continue;
				const B = r.rhs[dot];
				if (!(B instanceof NonTerminal))
					continue;
				for (const prod of this.rules) {
					if (prod.lhs !== B)
						continue;
					const ni: LR0Item = { rule: prod.id, dot: 0 };
					const k = lr0Key(ni);
					if (!inSet.has(k)) {
						inSet.add(k);
						queue.push(ni);
					}
				}
			}
			return queue;
		};

		const lr0Goto = (items: LR0Item[], sym: InternalSym): LR0Item[] => {
			const moved = items
				.filter(i => {
					const r = this.rules[i.rule];
					return i.dot < r.rhs.length && r.rhs[i.dot] === sym;
				})
				.map(i => ({ rule: i.rule, dot: i.dot + 1 }));
			return moved.length ? lr0Closure(moved) : [];
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
					if (!(sym instanceof NonTerminal))
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

			if (shiftPrec !== undefined && reducePrec !== undefined) {
				if (reducePrec.level > shiftPrec.level) {
					row.set(term, reduceEntry);
					conflicts.push({ state, term, kind: 'shift-reduce', resolution: 'reduce (reduce-rule prec > shift-rule prec)' });
				} else if (reducePrec.level < shiftPrec.level) {
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
					conflicts.push({ state, term, kind: 'conflict', resolution: 'error (nonassoc)' });
				}
			} else {
				row.set(term, shiftEntry);
				conflicts.push({ state, term, kind: 'shift-reduce', resolution: 'shift (default, no prec info)' });
			}
			return;
		}

		if (existing.kind === 'reduce' && incoming.kind === 'reduce') {
			const winner = existing.rule < incoming.rule ? existing : incoming;
			row.set(term, winner);
			conflicts.push({ state, term, kind: 'reduce-reduce', resolution: `reduce by rule ${winner.rule} (earlier rule wins)` });
		}
		// shift-shift / accept: keep existing (shouldn't occur in valid grammars)
	}
}

// ===================================================================
//  Parser runtime
// ===================================================================

export interface Token {
	type:	Terminal;
	value:	string;	// semantic value; available as $[i] in actions
	pos?:	TextPos;
}


function advancePos(state: TextPos, text: string) {
	for (const ch of text) {
		if (ch === '\n') {
			state.line++;
			state.col = 1;
			console.log(state.line);
		} else {
			state.col++;
		}
	}
	state.offset += text.length;
	return state;
}

export interface TokenStream {
	// `allowed`, if given, is consulted only while computing a fresh token (i.e. the first peek() since the last consume())
	peek(allowed?: Map<Terminal, ActionEntry>): Token;
	peekText(): string;
	consume(): void;
}

type TryRecover = (row: Map<Terminal, ActionEntry>, tok: Token, prevToken: Token | undefined) => { entry: ActionEntry; tok: Token; } | undefined

export type MergeFn = (left: unknown, right: unknown) => unknown;
const defaultMerge: MergeFn = (left, right) => Array.isArray(left) ? [...left, right] : [left, right];

export function nextToken(entries: Terminal[], input: string, state: LexState, ctx: any, resolveSym: (sym: string|RegExp|Terminal|undefined) => Terminal|undefined, allowed?: Map<Terminal, ActionEntry>): Token {

	while (state.offset < input.length) {
		const candidates: { term: Terminal; len: number }[] = [];
		for (const term of entries) {
			const re = term.pattern!;
			re.lastIndex = state.offset;
			const m = re.exec(input);
			if (m && m[0].length > 0)
				candidates.push({ term, len: m[0].length });
		}
		candidates.sort((a, b) => b.len - a.len
			|| (a.term.pattern!.source < b.term.pattern!.source ? 1 : a.term.pattern!.source > b.term.pattern!.source ? -1 : 0));

		let chosen:			{ finalTerm: Terminal; len: number } | undefined;
		let firstViable:	{ finalTerm: Terminal; len: number } | undefined;
		for (const { term, len } of candidates) {
			let result: Terminal | undefined;
			if (!term.lex) {
				result = term;
			} else {
				const text = input.slice(state.offset, state.offset + len);
				result = resolveSym(term.lex({
					...state,
					text,
					ctx,
					peekNext: () => nextToken(entries, input, advancePos({...state}, text), ctx, resolveSym, allowed),
					peekText: () => input.substring(state.offset)
				}));
			}
			if (result) {
				firstViable ??= { finalTerm: result, len };
				if (!allowed || result.ignore || allowed.has(result)) {
					chosen = { finalTerm: result, len };
					break;
				}
			}
		}
		chosen ??= firstViable;

		if (!chosen)
			throw new SyntaxError(`Unexpected character '${input[state.offset]}' at line ${state.line}, col ${state.col}`);

		const { finalTerm, len } = chosen;
		const matched	= input.slice(state.offset, state.offset + len);
		const token		= !finalTerm.ignore
			? { type: finalTerm, value: matched, pos: { offset: state.offset, line: state.line, col: state.col } }
			: null;

		advancePos(state, matched);

		if (token) {
			state.prev = finalTerm;
			return token;
		}
	}
	return { type: EOF, value: '', pos: { offset: state.offset, line: state.line, col: state.col }};
}

function dumpStack(valueStack: readonly unknown[]) {
	console.error('Stack dump:');
	for (let i = 0; i < valueStack.length; i++)
		console.error(`${'  '.repeat(i)}value: ${JSON.stringify(valueStack[i])}`);
}

export function runParser(tables: ParseTables, stream: TokenStream, ctx: any, tryRecover: TryRecover, mergeFns: Record<number, MergeFn> = {}) {
	let stateStack: number[]	= [0];
	let valueStack: unknown[]	= [];
	let lastShifted: Token | undefined;

	while (true) {
		const row			= tables.action[stateStack[stateStack.length - 1]];
		const realTok		= stream.peek(row);
		const fromRecovery	= !row.has(realTok.type) ? tryRecover(row, realTok, lastShifted) : undefined;
		const entry			= fromRecovery?.entry ?? row.get(realTok.type);
		const tok			= fromRecovery?.tok ?? realTok;

		if (!entry) {
			dumpStack(valueStack);
			const expected = [...row.keys()].filter(k => k !== EOF).map(k => k.name);
			throw new SyntaxError(
				`Unexpected token '${realTok.type.name}'${realTok.pos ? ` at line ${realTok.pos.line}, col ${realTok.pos.col}` : ' at end of input'}. `
				+ `Expected: ${expected.length ? expected.join(', ') : '(nothing)'}`
			);
		}

		if (entry.kind === 'conflict') {
			const result = runGlrFork(tables, stream, ctx, mergeFns, tryRecover, stateStack, valueStack, lastShifted);
			if (result.accepted)
				return result.value;
			({stateStack, valueStack, lastShifted } = result);

		} else if (entry.kind === 'shift') {
			stateStack.push(entry.state);
			valueStack.push(tok.value);
			if (!fromRecovery) {
				stream.consume();
				lastShifted = realTok;
			}
		} else if (entry.kind === 'reduce') {
			const rule		= tables.rules[entry.rule];
			const rhsLen	= rule.rhs.length;
			const vals		= valueStack.splice(valueStack.length - rhsLen, rhsLen);
			stateStack.splice(stateStack.length - rhsLen, rhsLen);

			const topState	= stateStack[stateStack.length - 1];
			const nextState = tables.goto[topState].get(rule.lhs);
			if (nextState === undefined)
				throw new Error(`No GOTO entry for state ${topState}, non-terminal '${rule.lhs.name}'`);

			stateStack.push(nextState);
			const value = rule.action(vals, ctx);
			//console.log(`${'  '.repeat(stateStack.length)}${rule.lhs.name} -> ${rule.rhs.map(r => r.name).join(' ')}, made: ${JSON.stringify(value)}`);
			valueStack.push(value);//rule.action(vals, ctx));
		} else {
			// accept
			return valueStack[valueStack.length - 1];
		}
	}
}


// ===================================================================
//  GLR fork explorer
// ===================================================================

type GlrForkResult =
	| { accepted: true; value: unknown }
	| { accepted: false; stateStack: number[]; valueStack: unknown[]; lastShifted: Token | undefined };


function runGlrFork(
	tables: ParseTables, stream: TokenStream, ctx: any, mergeFns: Record<number, MergeFn>, tryRecover: TryRecover,
	stateStack: readonly number[], valueStack: readonly unknown[], lastShifted: Token | undefined,
): GlrForkResult {

	interface StackFrame {
		id:		number;			// identifies this exact frame, for convergence keys below
		parent: StackFrame | null;
		state:	number;
		value:	unknown;
	}

	interface Path {
		id:		number;
		top:	StackFrame;
	}

	let frameIdCounter	= 0;
	let pathIdCounter	= 0;
	let accepted		= false;
	let acceptedValue: unknown;

	const makeFrame		= (parent: StackFrame | null, state: number, value: unknown) => ({ id: frameIdCounter++, parent, state, value });
	const makePath		= (top: StackFrame): Path => ({ id: pathIdCounter++, top });
	const convergeKey	= (top: StackFrame) => `${top.state}:${top.parent ? top.parent.id : -1}`;
	const mergeInto		= (into: StackFrame, incoming: StackFrame) => makeFrame(into.parent, into.state, (mergeFns[into.state] ?? defaultMerge)(into.value, incoming.value));

	// Flat stack -> frame chain
	let frame = makeFrame(null, stateStack[0], undefined);
	for (let i = 1; i < stateStack.length; i++)
		frame = makeFrame(frame, stateStack[i], valueStack[i - 1]);

	const activeLists: Path[][] = [[makePath(frame)]];

	for (let i = 0; ; i++) {
		const active = activeLists[i];
		if (!active || active.length === 0)
			throw new SyntaxError(`No active parse paths at position ${i}`);

		// Several paths can be active at once, each in its own state -- a token valid for *any* of them is fair game, so the lexer restriction is their rows' union, not any single one's.
		const allowed = new Map<Terminal, ActionEntry>();
		for (const path of active)
			for (const [term, entry] of tables.action[path.top.state])
				allowed.set(term, entry);

		const tok		= stream.peek(allowed);
		const byKey		= new Map<string, Path>(active.map(p => [convergeKey(p.top), p]));
		const worklist	= [...active];
		const shifted	= new Map<number, Path[]>();	// next position -> paths to merge there

		// Register a freshly-produced same-position frame merging with whatever's already live at that state+parent.
		const registerAtPosition = (newTop: StackFrame) => {
			const key		= convergeKey(newTop);
			const existing	= byKey.get(key);
			const path		= makePath(existing ? mergeInto(existing.top, newTop) : newTop);
			byKey.set(key, path);
			worklist.push(path);
		};

		const applyAction = (path: Path, entry: ActionEntry, actionTok: Token, stayAtSamePosition: boolean) => {
			if (entry.kind === 'shift') {
				const top = makeFrame(path.top, entry.state, actionTok.value);
				if (stayAtSamePosition) {
					registerAtPosition(top);
				} else {
					if (!shifted.has(i + 1))
						shifted.set(i + 1, []);
					shifted.get(i + 1)!.push(makePath(top));
				}

			} else if (entry.kind === 'reduce') {
				const	rule	= tables.rules[entry.rule];
				let		top		= path.top;
				let		n		= rule.rhs.length;
				const vals: unknown[] = new Array(n);
				while (n--) {
					vals[n]	= top.value;
					top		= top.parent!;
				}
				const reducedValue	= rule.action(vals, ctx);
				const nextState		= tables.goto[top.state]?.get(rule.lhs);
				if (nextState !== undefined)
					registerAtPosition(makeFrame(top, nextState, reducedValue));

			} else { // accept
				acceptedValue = path.top.value;
				accepted = true;
			}
		};

		while (worklist.length > 0 && !accepted) {
			const path	= worklist.shift()!;
			// A path superseded by a later merge at the same key is a dead end: skip it, since the merged successor (already on the worklist) carries the real value.
			if (byKey.get(convergeKey(path.top)) !== path)
				continue;

			const row			= tables.action[path.top.state];
			const fromRecovery	= !row.has(tok.type) ? tryRecover(row, tok, lastShifted) : undefined;
			const entry			= fromRecovery?.entry ?? row.get(tok.type);
			if (entry) {
				const actionTok = fromRecovery?.tok ?? tok;
				if (entry.kind === 'conflict') {
					for (const inner of entry.entries)
						applyAction(path, inner, actionTok, !!fromRecovery);
				} else {
					applyAction(path, entry, actionTok, !!fromRecovery);
				}
			}
		}

		if (accepted)
			return { accepted: true, value: acceptedValue };

		if (tok.type === EOF)
			throw new SyntaxError('Parse completed without accept');

		stream.consume();
		lastShifted = tok;

		// Merge converging paths landing on i + 1 (same derivation reached by separate shifts).
		for (const [pos, paths] of shifted) {
			const merged = new Map<string, Path>();
			for (const path of paths) {
				const key		= convergeKey(path.top);
				const existing	= merged.get(key);
				merged.set(key, existing ? makePath(mergeInto(existing.top, path.top)) : path);
			}
			activeLists[pos] = Array.from(merged.values());
		}

		// Settled back down to a single derivation -- hand it back to runParser's fast loop
		if (activeLists[i + 1] && activeLists[i + 1].length === 1) {
			// Frame chain -> flat stack
			const stateStack: number[] = [];
			const valueStack: unknown[] = [];
			for (let frame: StackFrame | null = activeLists[i + 1][0].top; frame; frame = frame.parent) {
				stateStack.push(frame.state);
				if (frame.parent)
					valueStack.push(frame.value);
			}
			stateStack.reverse();
			valueStack.reverse();
			return { accepted: false, stateStack, valueStack, lastShifted };
		}
	}
}

// ===================================================================
//  Main entry point
// ===================================================================

export function tison(spec: GrammarSpec,
	merge?:		Record<number, MergeFn>, 	// Merge functions for ambiguous convergence points. Key = LALR state id (see tables.action.length).
): Parser {
	const g = new GrammarBuilder(spec);

	const tables	= g.buildTables();
	const lexEntries = Array.from(g.terminalsByName.values()).filter(t => t.pattern);

	const recover	= (row: Map<Terminal, ActionEntry>, tok: Token, prevToken: Token | undefined) => {
		const substitute = spec.recover?.(row, tok, prevToken);
		if (!substitute)
			return undefined;
		const entry = row.get(substitute.type);
		return entry && { entry, tok: substitute };
	};

	const resolveSym = (sym: string|RegExp|Terminal|undefined): Terminal|undefined =>
		typeof sym === 'string'		? g.terminalsByName.get(sym)
		: sym instanceof RegExp		? g.terminalsByName.get(sym.source)
		: sym;


	const createTokenStream = (lexEntries: Terminal[], input: string, ctx: any) => {
		const lexState: LexState = { offset: 0, line: 1, col: 1 };
		let lookahead: Token | undefined;
		return {
			peek: (allowed?: Map<Terminal, ActionEntry>): Token => lookahead ??= nextToken(lexEntries, input, lexState, ctx, resolveSym, allowed),
			peekText:	() => { return input.substring(lexState.offset); },
			consume:	() => { lookahead = undefined; }
		};
	};

	return {
		tables,
		parse: (input, ctx) => runParser(tables, createTokenStream(lexEntries, input, ctx), ctx, recover, merge ?? {})
	};
}
