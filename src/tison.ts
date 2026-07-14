// tison.ts -- A TypeScript-object-based LALR(1)/SLR(1)/GLR parser generator.
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
export type MergeFn = (left: unknown, right: unknown) => unknown;

function has0args<T>(fn: (() => T) | Action<T>): fn is ()=>T {
	return fn.length === 0;
}

// A literal that ends in a word character (e.g. 'var', 'in') is given an implicit trailing word-boundary, so it can never match as a strict prefix of a longer word
function literalPattern(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w/.test(s[s.length - 1]) ? '(?!\\w)' : '');
}

export interface Ref<T> { ref: string; }
export function Ref<T>(ref: string): Ref<T> {
	return {ref};
}
export function Forward<T>(ref: () => any) {
	return ref as (() => Rules<T>);
}
export interface TextPos {
	offset: number; line: number; col: number;
}
export type WithTextPos<T> = T & {pos: TextPos};

export interface Token {
	type:	Terminal;
	value:	string;	// semantic value; available as $[i] in actions
	pos:	TextPos;
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

export type TerminalCallback<C = any> = (lexctx: LexContext, ctx: C) => Token | Terminal | string | RegExp | undefined;
export type RecoveryCallback = (lex: LexPosition, row: Map<Terminal, ActionEntry>) => Token | Terminal | string | RegExp | undefined;

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

export type Action<T, C = any, A = any[]> = (values: WithTextPos<A>, ctx: C) => T
type GrammarSym<C = any> = string | RegExp | Terminal | Rules<any> | (()=>Rules<any>) | Ref<any> | Action<any, C>;

export type ElemValue<S> = S extends Rule2<infer U>[] ? U
	: S extends RegExp ? string
	: S extends Terminal<infer U> ? U
	: S extends (()=>infer U) ? ElemValue<U>
	: S extends Ref<infer U> ? U
	: S extends string ? S
	: S extends Action<infer U> ? U
	: unknown;

type ValuesOf<T extends readonly GrammarSym[]> = {[K in keyof T]: ElemValue<T[K]>}


export interface Rule<T> {
	rhs:		GrammarSym[];
	action?:	(values: WithTextPos<any[]>, ctx: any) => T;
	prec?:		Precedence;
	merge?:		MergeFn;
}

export function WithPrec<T>(rule: Rule<T>, prec: Precedence): Rule<T> {
	return {...rule, prec};
}
export function WithMerge<T>(rule: Rule<T>, merge: MergeFn): Rule<T> {
	return {...rule, merge};
}

export function Rule<R extends readonly GrammarSym[]>(rhs: R): Rule<ElemValue<R[0]>>;
export function Rule<T, R extends readonly GrammarSym[], C = any>(rhs: R, action: Action<T, C, ValuesOf<R>>): Rule<T>;
export function Rule(rhs: GrammarSym[], action?: Action<any, any>) {
	return { rhs, action };
}

// Pins `ctx`'s type to `C` for every rule built with the returned function
export function makeRule<C>(commonAction?: <T>(value: T, values: WithTextPos<any[]>, ctx: C)=>any) {
	function boundRule<R extends readonly GrammarSym<C>[]>(rhs: R): Rule<ElemValue<R[0]>>;
	function boundRule<T, R extends readonly GrammarSym<C>[]>(rhs: R, action: Action<T, C, ValuesOf<R>>): Rule<T>;
	function boundRule(rhs: GrammarSym[], action?: Action<any, any>) {
		return { rhs, action: commonAction && action ? (values: WithTextPos<any[]>, ctx: C) => commonAction(action(values, ctx), values, ctx) : action };
	}
	return boundRule;
}

type Rule2<T> = Rule<T> | Rules<T> | (()=>Rules<T>)
export type Rules<T> = Rule2<T>[]

export function Rules<T>(...alts: Rules<T>): Rules<T> {
	return alts;
}
export function RRules<T>(builder: (self: () => Rules<T>) => Rules<T>): Rules<T> {
	const rules: Rules<T> = builder(() => rules);
	return rules;
}

export function Maybe<T>(rule: Rules<T>) {
	return Rules(
		Rule([], () => undefined),
		rule,
	);
}

export function List<T>(single: Rules<T> | (()=>Rules<T>), sep?: GrammarSym, trailing?: boolean) {
	return RRules<T[]>(self => [
		Rule([single] as const,	$ => [$[0]]),
		sep
			? Rule([self, sep, single] as const,	$ => [...($[0] as T[]), $[2]])
			: Rule([self, single] as const,			$ => [...($[0] as T[]), $[1]]),
		...(sep && trailing ? [Rule([self, sep] as const, $ => $[0] as T[])] : []),
	]);
}

export function MaybeList<T>(rule: Rules<T>, sep?: GrammarSym, trailing?: boolean) {
	return Rules(
		List(rule, sep, trailing),
		Rule([], () => []),
	);
}


export function OneOf<T extends string>(names: readonly T[]) {
	return Rules(...names.map(name => Rule([name])));
}

export type TermLike = RegExp | string | Terminal;

export interface GrammarSpec {
	precedence?:	Record<string, Assoc | PrecEntry>;
	start?:			Rules<any>;		// defaults to the first value of `rules`
	rules?:			Record<string, Rules<any>>;
	skip?:			TermLike[];
	terminals?:		TermLike[];
	recover?:		RecoveryCallback;
	optimize?:		boolean;		// default true: bypass pass-through unit-rule GOTO hops in the built tables (see eliminateUnitGotos); set false to parse with the raw tables when debugging a suspect parse
	lalr?:			boolean;		// default true (real per-state LALR(1) reduce lookaheads); set false for the older, strictly weaker SLR(1) global-FOLLOW-set lookaheads instead -- see `buildTables`'s header comment
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
const identityAction: Action<unknown> = values => values[0];

export interface InternalRule {
	id:			number;
	lhs:		NonTerminal;
	rhs:		InternalSym[];
	action: 	Action<unknown>;
	prec?:		PrecEntry;
	peek?:		number;		// extra preceding stack values to pass to `action` without popping them (mid-rhs actions: values of the symbols before them in the containing rule)
	merge?:		MergeFn;	// GLR convergence combiner for this rule's ambiguous reduce, carried over from the user Rule
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
			const lhs	= new NonTerminal(`anon ${this.rules.length}`);
			this.first.set(lhs, { terms: new Set(), nullable: false });
			const r = this.addRule(lhs, [], action);
			r.peek = peek;
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

		this.addRule(ACCEPT, [this.startSymbol, EOF]);

		// -- Discover non-terminals -----------------------------------

		const resolveSym = (sym: GrammarSym, i: number) =>
			typeof sym === 'string'		? nonTerminalsByName.get(sym) ?? internTerminal(sym, new RegExp(literalPattern(sym)))
			: typeof sym === 'function'	? (has0args(sym) ? internByRules(sym()) : anon(sym, i))
			: sym instanceof RegExp		? internTerminal(sym.source, sym)
			: sym instanceof Terminal	? this.terminalsByName.get(sym.name) ?? addTerminal(sym)
			: 'ref' in sym				? nonTerminalsByName.get(sym.ref)!
			: internByRules(sym)!;

		for (const r of rules) {
			const lhs = nonTerminalsByRules.get(r)!;
			for (const alt of r) {
				if (typeof alt === 'function') {
					this.addRule(lhs, [internByRules(alt())]);
				} else if (Array.isArray(alt)) {
					this.addRule(lhs, [internByRules(alt)]);
				} else {
					const r = this.addRule(lhs, alt.rhs.map(resolveSym), alt.action);
					r.prec = alt.prec === undefined ? undefined : typeof alt.prec === 'string' ? prec.get(alt.prec) : alt.prec;
					r.merge = alt.merge;
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

	private addRule(lhs: NonTerminal, rhs: InternalSym[], action?: Action<unknown>): InternalRule {
		const r: InternalRule = {
			id:		this.rules.length,
			lhs,
			rhs,
			action:	action ?? identityAction
		};
		this.rules.push(r);
		return r;
	}

	// -- SLR(1)/LALR(1) table construction -------------------------------------
	//
	// Builds the LR(0) automaton, then (when `lalr`) computes per-state LALR(1) reduce lookaheads via
	// fixed-point propagation over it, rather than the canonical-LR(1)-then-merge approach (avoids that
	// method's state explosion). The propagation is monotone over a finite domain so it always terminates;
	// `LALR_MAX_PASSES` is just a tripwire against that invariant ever breaking.
	// `lalr: false` falls back to plain FOLLOW(lhs)-based SLR(1) lookaheads (weaker: more spurious
	// conflicts, but no correctness difference since conflicts still resolve via precedence/GLR either way).
	buildTables(lalr = true): ParseTables {
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

		// `lalrLA[state]` maps an LR(0) item (by `lr0Key`) to the terminals valid for reducing it in that state.
		// Seeded from the accept item's `{EOF}` lookahead, then propagated to a fixed point:
		//   - closure: item `A -> α.Bβ` with lookahead L gives every `B -> .γ` in the same state FIRST(β) (plus L if β is nullable).
		//   - goto: an item's lookahead carries unchanged into the corresponding item after a shift/goto on its next symbol.
		let lalrLA: Map<string, Set<Terminal>>[] | undefined;
		if (lalr) {
			lalrLA = lr0States.map(() => new Map<string, Set<Terminal>>());

			const addLA = (state: number, item: LR0Item, terms: Iterable<Terminal>): boolean => {
				const k = lr0Key(item);
				let set = lalrLA![state].get(k);
				if (!set)
					lalrLA![state].set(k, set = new Set());
				let added = false;
				for (const t of terms) {
					if (!set.has(t)) {
						set.add(t);
						added = true;
					}
				}
				return added;
			};

			addLA(0, { rule: 0, dot: 0 }, [EOF]);

			const LALR_MAX_PASSES = numStates * 8 + 1000;
			let pass = 0;
			for (let changed = true; changed; ) {
				if (++pass > LALR_MAX_PASSES)
					throw new Error(`LALR(1) lookahead propagation did not converge after ${LALR_MAX_PASSES} passes -- this is a table-construction bug, not a grammar problem`);
				changed = false;
				for (let s = 0; s < numStates; s++) {
					for (const item of lr0States[s]) {
						const itemLA = lalrLA[s].get(lr0Key(item));
						if (!itemLA)
							continue;
						const rule = this.rules[item.rule];
						const sym = rule.rhs[item.dot];
						if (sym === undefined)
							continue; // complete item -- nothing to propagate from here (handled as a reduce below)

						if (sym instanceof NonTerminal) {
							let restNullable = true;
							const firstOfRest = new Set<Terminal>();
							for (let j = item.dot + 1; j < rule.rhs.length; j++) {
								const sf = this.first.get(rule.rhs[j])!;
								for (const f of sf.terms)
									firstOfRest.add(f);
								if (!sf.nullable) {
									restNullable = false;
									break;
								}
							}
							const laForClosure = restNullable ? new Set([...firstOfRest, ...itemLA]) : firstOfRest;
							for (const prod of this.rules) {
								if (prod.lhs === sym && addLA(s, { rule: prod.id, dot: 0 }, laForClosure))
									changed = true;
							}
						}

						const target = lr0Trans[s].get(sym);
						if (target !== undefined && addLA(target, { rule: item.rule, dot: item.dot + 1 }, itemLA))
							changed = true;
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
				if (item.dot >= r.rhs.length && r.lhs !== ACCEPT) {
					const lookaheads = lalr ? (lalrLA![s].get(lr0Key(item)) ?? new Set<Terminal>()) : follow.get(r.lhs)!;
					for (const la of lookaheads)
						this.setAction(action[s], la, { kind: 'reduce', rule: item.rule }, s, shiftRule[s].get(la)?.prec, conflicts);
				}
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
			rules:		this.rules,
			conflicts,
		};
	}

	// -- Conflict resolution (Bison rules) ---------------------------

	private setAction(
		row:		Map<Terminal, ActionEntry>,
		term:		Terminal,
		incoming:	ActionEntry,
		state:		number,
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
				// Name the silently-losing reduce rule: unflagged default-shifts are the classic source of
				// "wrong parse, no error" bugs here, and knowing which rule lost is the first debugging step.
				const lost = this.rules[reduceEntry.rule];
				conflicts.push({ state, term, kind: 'auto', resolution: `shift (default, no prec info; loses reduce of rule ${lost.id}: ${lost.lhs.name} -> ${lost.rhs.map(s => s.name).join(' ')})` });
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

function getTextPos(x: TextPos) {
	return {offset: x.offset, line: x.line, col: x.col };
}

function advancePos(state: TextPos, text: string) {
	for (const ch of text) {
		if (ch === '\n') {
			state.line++;
			state.col = 1;
		} else {
			state.col++;
			if (ch === '\t')
				state.col = Math.floor((state.col + 3) / 4) * 4;
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

// Combines two GLR derivation paths that converged onto the same state+parent (see `runGlrFork`). Two paths
// converging on an identical value aren't a real ambiguity (same parse reached two ways) so collapse rather
// than accumulate an array.
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const defaultMerge: MergeFn = (left, right) => {
	if (Array.isArray(left))
		return left.some(v => sameValue(v, right)) ? left : [...left, right];
	return sameValue(left, right) ? left : [left, right];
};

function nextToken(allowed: Map<Terminal, ActionEntry>, input: string, state: TextPos & { prev?: Token }, ctx: any, resolveSym: (sym: Token|Terminal|string|RegExp|undefined) => Token|Terminal|undefined): Token {

	while (state.offset < input.length) {
		const pos = getTextPos(state);
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

		let chosen = false;
		for (const { term, len } of candidates) {
			const match = input.slice(state.offset, state.offset + len);

			if (!term.callback) {
				advancePos(state, match);
				if (allowed.get(term)?.kind !== 'ignore')
					return { type: term, value: match, pos };
				chosen = true;
				break;

			} else {
				const after		= advancePos({...state}, match);
				const result 	= resolveSym(term.callback({
					...state,
					match,
					remaining:	input.substring(after.offset),
					next: 		() => nextToken(allowed, input, after, ctx, resolveSym),
				}, ctx));

				if (result) {
					advancePos(state, match);
					// `result` is the callback's *returned* terminal (e.g. a contextual keyword like GET
					// downgrading itself to IDENT) -- using `term` (the originally-matched terminal) here
					// instead would silently discard that reclassification and always keep the keyword type.
					const type = result instanceof Terminal ? result : result.type;
					if (allowed.get(type)?.kind !== 'ignore')
						return { type, value: result instanceof Terminal ? match : result.value, pos };
					chosen = true;
					break;
				}
			}
		}

		if (!chosen)
			return { type: ERROR, value: input.substring(state.offset), pos};
	}
	return { type: EOF, value: '', pos: getTextPos(state)};
}

interface StackEntry { state: number; value: unknown; }

function recoverCtx(stream: Lexer): LexPosition {
	return { offset: stream.offset, line: stream.line, col: stream.col, remaining: stream.peekText(), prev: stream.prev };
}

type RecoveryCallback2 = (stream: Lexer, row: Map<Terminal, ActionEntry>) => Token | undefined;

function runParser(tables: ParseTables, stream: Lexer, ctx: any, recover: RecoveryCallback2) {
	const stack: StackEntry[] = [{ state: 0, value: undefined }];

	let realTok		= stream.next(tables.action[0]);

	// A `recover`-synthesized token never consumes `realTok` -- only a genuine shift/reduce advances
	// `stream.offset`. Recovery firing forever at the same offset means it's stuck re-synthesizing against
	// the same unconsumed token; the bound is generous since a few recovery-driven reduces can legitimately precede a real shift.
	let recoveryStuckAt: number | undefined;
	let recoveryStuckCount = 0;
	const MAX_RECOVERY_AT_SAME_OFFSET = 50;

	while (true) {
		const row			= tables.action[stack[stack.length - 1].state];
		const direct		= row.get(realTok.type);
		const usingRecovery	= !direct || direct.kind === 'error';
		if (usingRecovery) {
			// Not reset on non-recovery steps: a stuck cycle alternates recovery with shift/reduce of the
			// synthesized token itself, so consecutive recovery steps are rare even when truly stuck --
			// compare against `stream.offset` (real progress) instead.
			recoveryStuckCount = recoveryStuckAt === stream.offset ? recoveryStuckCount + 1 : 1;
			recoveryStuckAt = stream.offset;
			if (recoveryStuckCount > MAX_RECOVERY_AT_SAME_OFFSET) {
				const pos = recoverCtx(stream);
				throw new SyntaxError(
					`Parser stuck in error recovery at line ${pos.line}, col ${pos.col} `
					+ `(recovery keeps re-inserting a token without consuming '${realTok.type.name}') -- this is a parser/grammar bug, not just invalid input.`
				);
			}
		}
		const tok			= usingRecovery ? recover(stream, row) : realTok;
		const entry			= tok && row.get(tok.type);

		if (!entry || entry.kind === 'error') {
			const expected	= [...row].filter(([k, v]) => k !== EOF && v.kind !== 'error' && v.kind !== 'ignore').map(([k]) => k.name);
			const pos		= recoverCtx(stream);
			throw new SyntaxError(
				(realTok.type !== ERROR ? `Unexpected token '${realTok.type.name}'` : `Unexpected character '${pos.remaining[0] ?? ''}'`)
				+ ` at line ${pos.line}, col ${pos.col}. `
				+ `Expected: ${expected.length ? expected.join(', ') : '(nothing)'}`
			);
		}

		if (entry.kind === 'conflict') {
			const result = runGlrFork(tables, stream, tok, ctx, recover, stack);
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
			const vals		= Object.assign([
				...(peek ? stack.slice(stack.length - rhsLen - peek, stack.length - rhsLen).map(e => e.value) : []),
				...stack.splice(stack.length - rhsLen, rhsLen).map(e => e.value)
			], {pos: tok.pos});

			const topState	= stack[stack.length - 1].state;
			const state = tables.goto[topState].get(rule.lhs);
			if (state === undefined)
				throw new Error(`No GOTO entry for state ${topState}, non-terminal '${rule.lhs.name}'`);

			const value = rule.action(vals, ctx);
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
function runGlrFork(tables: ParseTables, stream: Lexer, tok: Token, ctx: any, recover: RecoveryCallback2, stack: StackEntry[]): GlrForkResult {

	interface StackFrame extends StackEntry {
		id:		number;			// identifies this exact frame, for convergence keys below
		parent: StackFrame | null;
	}

	let frameIdCounter	= 0;
	let accepted		= false;
	let acceptedValue: unknown;

	const makeFrame		= (parent: StackFrame | null, state: number, value: unknown) => ({ id: frameIdCounter++, parent, state, value });
	const convergeKey	= (top: StackFrame) => `${top.state}:${top.parent ? top.parent.id : -1}`;
	const mergeInto		= (into: StackFrame, incoming: StackFrame, ruleId?: number) =>
		makeFrame(into.parent, into.state, ((ruleId !== undefined ? tables.rules[ruleId].merge : undefined) ?? defaultMerge)(into.value, incoming.value));

	// Flat stack -> frame chain
	let frame = makeFrame(null, stack[0].state, undefined);
	for (let i = 1; i < stack.length; i++)
		frame = makeFrame(frame, stack[i].state, stack[i].value);

	let active = new Map([[convergeKey(frame), frame]]);

	// Bounds all work across this call (any cause of runaway path explosion), on top of the more specific
	// recovery-stuck check below.
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
				const	vals	= Object.assign(new Array<unknown>(n + peek), {pos: actionTok.pos});
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

		// Same recovery-stuck hazard as `runParser` (see there), shaped differently: a recovery-synthesized
		// token can re-register onto this same worklist instead of advancing, churning forever without `tok`
		// ever being consumed.
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
			const actionTok		= usingRecovery ? recover(stream, row) : tok;
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
		if (!shifted.length) {
			const pos = recoverCtx(stream);
			throw new SyntaxError(`No active GLR fork paths survived to token ${i + 1} (at line ${pos.line}, col ${pos.col}, near '${tok.type.name}') -- every forked derivation died out; this is a parser/grammar bug, not just invalid input.`);
		}

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
//  Unit-rule GOTO bypass
// ===================================================================
// When a reduce lands on a state whose only possible move is reducing a pass-through unit rule (`A -> B`,
// identity action), that hop is a no-op: redirecting goto(s, B) straight to goto(s, A) at table-build time
// skips it.
//
// IMPORTANT: only GOTO entries are rewritten, never shift targets -- action rows double as the lexer's
// allowed-terminal sets, which must stay byte-identical for candidate-restricted terminal callbacks
// (regex-vs-divide, ASI, contextual keywords) to keep making the same choices. Don't extend this to shifts.
//
// A state qualifies only if every action is the SAME identity-unit reduce and it has no gotos of its own.
function eliminateUnitGotos(tables: ParseTables): number {
	// Reduce-only states and the nonterminal their unit rule forwards to.
	const bypass = new Map<number, NonTerminal>();
	for (let s = 0; s < tables.action.length; s++) {
		if (tables.goto[s].size)
			continue;
		let ruleId = -1;
		for (const entry of tables.action[s].values()) {
			if (entry.kind === 'ignore' || entry.kind === 'error')
				continue;
			if (entry.kind !== 'reduce' || (ruleId >= 0 && ruleId !== entry.rule)) {
				ruleId = -2;
				break;
			}
			ruleId = entry.rule;
		}
		if (ruleId < 0)
			continue;
		const rule = tables.rules[ruleId];
		// `!rule.merge`: a rule with a GLR convergence combiner must keep its reduce, since bypassing it
		// would also skip the merge hook that fires when two fork paths converge on that reduce.
		if (rule.action === identityAction && !rule.merge && !rule.peek && rule.rhs.length === 1 && rule.rhs[0] instanceof NonTerminal)
			bypass.set(s, rule.lhs);
	}

	// Redirect until stable: a redirect target can itself be a bypassable state (chained unit rules).
	// The iteration cap guards against pathological unit *cycles* (`A -> B`, `B -> A`); real chains are no deeper than the grammar's unit nesting.
	let redirected = 0;
	for (let changed = true, guard = 100; changed && guard--; ) {
		changed = false;
		for (const gotoRow of tables.goto) {
			for (const [nt, target] of gotoRow) {
				const lhs = bypass.get(target);
				if (lhs && lhs !== nt) {
					const fwd = gotoRow.get(lhs);
					if (fwd !== undefined && fwd !== target) {
						gotoRow.set(nt, fwd);
						redirected++;
						changed = true;
					}
				}
			}
		}
	}
	return redirected;
}

// ===================================================================
//  Main entry point
// ===================================================================

export function makeParser(spec: GrammarSpec): Parser {
	const g			= new GrammarBuilder(spec);
	const tables	= g.buildTables(spec.lalr ?? true);

	if (spec.optimize !== false)
		eliminateUnitGotos(tables);

	const resolveSym = (sym: Token|Terminal|string|RegExp|undefined): Token|Terminal|undefined =>
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

	const makeRecover = (recover?: RecoveryCallback): RecoveryCallback2 => {
		return recover
			? (stream, row) => {
				const result = resolveSym(recover(recoverCtx(stream), row));
				if (result)
					return result instanceof Terminal ? {type: result, value: '', pos: getTextPos(stream)} : result;
				return undefined;
			}
			: (_stream, _row) => undefined;
	};

	return {
		tables,
		parse: (input, ctx) => runParser(tables, makeLexer(input, ctx), ctx, makeRecover(spec.recover))
	};
}
