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
function literalPattern(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w/.test(s[s.length - 1]) ? '(?!\\w)' : '');
}

// One regex matching any of `names` -- each alternative gets the same
// implicit word-boundary treatment as individual literal sugar (see
// `literalPattern`), so e.g. 'in' and 'instanceof' in the same list don't
// need to be ordered carefully relative to each other.
export function reOneOf(names: readonly string[]) {
	return new RegExp(names.map(literalPattern).join('|'));
}

// Context given to a terminal's `lex` callback once its pattern has matched at the current position.
// The callback decides what (if anything) this match actually is:
//   - return undefined to reject the match (it won't compete this round, so a shorter match from a different terminal can win instead)
//   - return the terminal itself to accept it normally
//   - return a different terminal to reclassify the match as that instead
// `peekNext` looks past this match non-destructively, for terminals (like whitespace) that need to know what's coming to decide how to classify themselves
export interface LexContext {
	text:		string;
	prev:		Terminal | undefined;
	peekNext:	() => Token | null;
}

export type LexCallback = (ctx: LexContext) => Terminal | string | RegExp | undefined

export class Terminal {
	ignore = false;
	pattern?: RegExp;
	constructor(public name: string, pattern?: RegExp, public lex?: LexCallback) {
		if (pattern)
			this.pattern = new RegExp(pattern.source, 'y' + pattern.flags.replace(/[gyd]/g, ''));
	}
}

export function terminal(pattern: RegExp, lex?: LexCallback) {
	return new Terminal(pattern.source, pattern, lex);
}
export function virtualTerminal(name: string) {
	return new Terminal(name);
}

type Sym = string | RegExp | Terminal | Alt<any, any>[];

type ElemValue<S> = S extends Alt<infer U, any>[] ? U : S extends RegExp | Terminal ? string : unknown;
type ValuesOf<T extends readonly Sym[]> = {[K in keyof T]: ElemValue<T[K]>}

export interface Alt<T, R extends readonly Sym[]> {
	rhs:		R;
	action?:	(values: ValuesOf<R>) => T;
	prec?:		string;
}
export type ValueOf<R> = R extends Alt<infer T, any>[] ? T : never;

export function Rule<T, R extends readonly Sym[]>(rhs: R, action?: (values: ValuesOf<R>) => T, prec?: string): Alt<T, R> {
	return { rhs, action, prec };
}
export function Rules<T>(...alts: Alt<T, any>[]) {
	return alts;
}

type Assoc = 'left' | 'right' | 'nonassoc';
export interface Precedence {
	name:		string;
	assoc:		Assoc;
}

export interface GrammarSpec {
	skip?:			(RegExp | Terminal)[];
	precedence?:	Record<string, Assoc>;
	start?:			string;		// defaults to the first key of `rules`
	rules:			Record<string, Alt<any, any>[]>;
	recover?: (row: Map<Terminal, ActionEntry>, token: Token, prevToken: Token | undefined) => Token | undefined;
}

export interface Parser {
	parse(input: string): unknown;
	tables: ParseTables;
}

// ===================================================================
//  Internal representation
// ===================================================================

export class NonTerminal {
	constructor(public name: string) {}
}

export type InternalSym = Terminal | NonTerminal;

export const EOF		= new Terminal('$end');
export const ACCEPT	= new NonTerminal('$accept');

interface PrecEntry {
	level:		number;
	assoc:		Assoc;
}

export interface InternalRule {
	id:			number;
	lhs:		NonTerminal;
	rhs:		InternalSym[];
	action: 	(values: readonly unknown[]) => unknown;
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
	rules:		{ lhs: NonTerminal; rhsLen: number }[];
	conflicts:	ConflictReport[];
}

// ===================================================================
//  Grammar builder
// ===================================================================

export class GrammarBuilder {
	rules:		InternalRule[] = [];
	lexEntries:	Terminal[] = [];
	terminalsByName	= new Map<string, Terminal>();

	private first	= new Map<InternalSym, { terms: Set<Terminal>; nullable: boolean }>();
	private startSymbol: NonTerminal;

	constructor(spec: GrammarSpec) {
		const lhsNames = Object.keys(spec.rules);
		if (lhsNames.length === 0)
			throw new Error('tison: no rules supplied');


		const nonTerminalsByName	= new Map<string, NonTerminal>();
		const internNonTerminal		= (name: string): NonTerminal => {
			let nt = nonTerminalsByName.get(name);
			if (!nt) {
				nt = new NonTerminal(name);
				nonTerminalsByName.set(name, nt);
			}
			return nt;
		};

		const lexerTerminals	= new Set<Terminal>();
		const internTerminal	= (re: RegExp): Terminal => {
			let term = this.terminalsByName.get(re.source);
			if (!term) {
				term = new Terminal(re.source, re);
				this.terminalsByName.set(re.source, term);
				lexerTerminals.add(term);
			}
			return term;
		};

		// -- Precedence -----------------------------------------------
		// Levels are pure named abstractions -- rules opt into one via `prec`.

		const prec	= new Map<string, PrecEntry>();
		if (spec.precedence) {
			Object.entries(spec.precedence).forEach(([name, assoc], i) => {
				prec.set(name, { level: i, assoc: assoc });
			});
		}

		// -- Discover non-terminals -----------------------------------
		const byRules = new Map(lhsNames.map(lhs => [spec.rules[lhs], internNonTerminal(lhs)] as const));

		const resolveExternalTerminal = (term: Terminal): Terminal => {
			lexerTerminals.add(term);
			return term;
		};

		const internLiteral = (s: string): Terminal =>
			internTerminal(new RegExp(literalPattern(s)));

		const resolveSym = (sym: Sym) =>
			typeof sym === 'string'		? nonTerminalsByName.get(sym) ?? internLiteral(sym)
			: sym instanceof RegExp		? internTerminal(sym)
			: sym instanceof Terminal	? resolveExternalTerminal(sym)
			: byRules.get(sym)!;


		const resolved = lhsNames.flatMap(lhs => spec.rules[lhs].map(alt => ({
			lhs: internNonTerminal(lhs),
			rhs: alt.rhs.map(resolveSym),
			action: alt.action ?? (() => undefined) as any,
			prec: alt.prec !== undefined ? prec.get(alt.prec) : undefined,
		})));

		// -- Skip (whitespace/comments) ------------------------------------
		for (const s of spec.skip ?? [])
			(s instanceof Terminal ? resolveExternalTerminal(s) : internTerminal(s)).ignore = true;

		// -- Token registration -----------------------------------------
		this.lexEntries = Array.from(lexerTerminals).filter(t => t.pattern);

		// -- Augmented start rule -------------------------------------
		this.startSymbol = internNonTerminal(spec.start ?? lhsNames[0]);

		this.rules.push({
			id:		0,
			lhs:	ACCEPT,
			rhs:	[this.startSymbol, EOF],
			action: v => v[0],
		});

		// -- User rules -----------------------------------------------
		for (const r of resolved)
			this.rules.push({id: this.rules.length, ...r});

		// -- FIRST sets ---------------------------------------------------

		for (const t of lexerTerminals)
			this.first.set(t, { terms: new Set([t]), nullable: false });
		this.first.set(EOF, { terms: new Set([EOF]), nullable: false });
		for (const nt of nonTerminalsByName.values())
			this.first.set(nt, { terms: new Set(), nullable: false });
		this.first.set(ACCEPT, { terms: new Set(), nullable: false });

		for (let changed = true; changed;) {
			changed = false;
			for (const rule of this.rules) {
				const lhsFirst = this.first.get(rule.lhs)!;
				let allDeriveEps = true;
				for (const sym of rule.rhs) {
					const symFirst = this.first.get(sym)!;
					for (const f of symFirst.terms) {
						if (!lhsFirst.terms.has(f)) {
							lhsFirst.terms.add(f);
							changed = true;
						}
					}
					if (!symFirst.nullable) {
						allDeriveEps = false;
						break;
					}
				}
				if (allDeriveEps && !lhsFirst.nullable) {
					lhsFirst.nullable = true;
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

		let changed = true;
		while (changed) {
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

		// Per state+terminal, the rule whose item is about to shift that terminal --
		// precedence belongs to rules, so this is what a shift is compared against.
		const shiftRule = Array.from({ length: numStates }, () => new Map<Terminal, number>());

		// Build ACTION / GOTO tables
		const action	= Array.from({ length: numStates }, () => new Map<Terminal, ActionEntry>());
		const goto		= Array.from({ length: numStates }, () => new Map<NonTerminal, number>());
		const conflicts: ConflictReport[]	= [];

		for (let s = 0; s < numStates; s++) {
			for (const item of lr0States[s]) {
				const r = this.rules[item.rule];
				if (item.dot < r.rhs.length) {
					const sym = r.rhs[item.dot];
					if (sym instanceof Terminal && !shiftRule[s].has(sym))
						shiftRule[s].set(sym, item.rule);
				}
			}
			for (const [sym, target] of lr0Trans[s]) {
				if (sym instanceof Terminal)
					this.setAction(action[s], sym, sym === EOF ? { kind: 'accept' } : { kind: 'shift', state: target }, s, shiftRule[s].get(sym), conflicts);
				else
					goto[s].set(sym, target);
			}
			for (const item of lr0States[s]) {
				const r = this.rules[item.rule];
				if (item.dot < r.rhs.length || r.lhs === ACCEPT)
					continue;
				for (const la of follow.get(r.lhs)!)
					this.setAction(action[s], la, { kind: 'reduce', rule: item.rule }, s, shiftRule[s].get(la), conflicts);
			}
		}

		return {
			action,
			goto,
			rules:		this.rules.map(r => ({ lhs: r.lhs, rhsLen: r.rhs.length })),
			conflicts,
		};
	}

	// -- Conflict resolution (Bison rules) ---------------------------

	private setAction(
		row:		Map<Terminal, ActionEntry>,
		term:		Terminal,
		incoming:	ActionEntry,
		state:		number,
		shiftRuleId: number | undefined,
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
			const shiftPrec		= shiftRuleId !== undefined ? this.rules[shiftRuleId].prec : undefined;
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
	pos?:	{ offset: number; line: number; col: number };
}

export interface LexState {
	offset:			number;
	line:			number;
	col:			number;
	lastTerminal?:	Terminal;	// the most recently returned non-ignored terminal -- feeds LexContext.prev
}

export function nextToken(entries: Terminal[], input: string, state: LexState, resolveSym: (sym: string|RegExp|Terminal|undefined) => Terminal|undefined, allowed?: Map<Terminal, ActionEntry>): Token {

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

		let chosen: { finalTerm: Terminal; len: number } | undefined;
		let firstViable: { finalTerm: Terminal; len: number } | undefined;
		for (const { term, len } of candidates) {
			let result: Terminal | undefined;
			if (!term.lex) {
				result = term;
			} else {
				const text = input.slice(state.offset, state.offset + len);
				result = resolveSym(term.lex({
					text, prev: state.lastTerminal,
					peekNext: (): Token | null => {
						const clone: LexState = { offset: state.offset, line: state.line, col: state.col, lastTerminal: state.lastTerminal };
						for (const ch of text) {
							if (ch === '\n') {
								clone.line++;
								clone.col = 1;
							} else {
								clone.col++;
							}
						}
						clone.offset += len;
						return nextToken(entries, input, clone, resolveSym);
					},
				}));
			}
			if (!result)
				continue;
			firstViable ??= { finalTerm: result, len };
			if (!allowed || result.ignore || allowed.has(result)) {
				chosen = { finalTerm: result, len };
				break;
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

		for (const ch of matched) {
			if (ch === '\n') {
				state.line++;
				state.col = 1;
			} else {
				state.col++;
			}
		}
		state.offset += len;

		if (token) {
			state.lastTerminal = finalTerm;
			return token;
		}
	}
	return { type: EOF, value: '', pos: { offset: state.offset, line: state.line, col: state.col }};
}

export interface TokenStream {
	// `allowed`, if given, is consulted only while computing a fresh token (i.e. the first peek() since the last consume())
	peek(allowed?: Map<Terminal, ActionEntry>): Token;
	consume(): void;
}

type TryRecover = (row: Map<Terminal, ActionEntry>, tok: Token, prevToken: Token | undefined) => { entry: ActionEntry; tok: Token; } | undefined

export type MergeFn = (left: unknown, right: unknown) => unknown;
const defaultMerge: MergeFn = (left, right) => Array.isArray(left) ? [...left, right] : [left, right];

export function runParser(tables: ParseTables, stream: TokenStream, rules: InternalRule[], tryRecover: TryRecover, mergeFns: Record<number, MergeFn> = {}) {
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
			const expected = [...row.keys()].filter(k => k !== EOF).map(k => k.name);
			throw new SyntaxError(
				`Unexpected token '${realTok.type.name}'${realTok.pos ? ` at line ${realTok.pos.line}, col ${realTok.pos.col}` : ' at end of input'}. ` +
				`Expected: ${expected.length ? expected.join(', ') : '(nothing)'}`
			);
		}

		if (entry.kind === 'conflict') {
			const result = runGlrFork(tables, stream, rules, mergeFns, tryRecover, stateStack, valueStack, lastShifted);
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
			const rule		= rules[entry.rule];
			const rhsLen	= rule.rhs.length;
			const vals		= valueStack.splice(valueStack.length - rhsLen, rhsLen);
			stateStack.splice(stateStack.length - rhsLen, rhsLen);

			const topState	= stateStack[stateStack.length - 1];
			const nextState = tables.goto[topState].get(rule.lhs);
			if (nextState === undefined)
				throw new Error(`No GOTO entry for state ${topState}, non-terminal '${rule.lhs.name}'`);

			stateStack.push(nextState);
			valueStack.push(rule.action(vals));
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
	tables: ParseTables, stream: TokenStream, rules: InternalRule[], mergeFns: Record<number, MergeFn>, tryRecover: TryRecover,
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
				const	rule	= rules[entry.rule];
				let		top		= path.top;
				let		n		= rule.rhs.length;
				const vals: unknown[] = new Array(n);
				while (n--) {
					vals[n]	= top.value;
					top		= top.parent!;
				}
				const reducedValue	= rule.action(vals);
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
	if (g.lexEntries.length === 0)
		throw new Error('tison: every terminal must declare a pattern');

	const tables	= g.buildTables();

	const recover	= (row: Map<Terminal, ActionEntry>, tok: Token, prevToken: Token | undefined) => {
		const substitute = spec.recover?.(row, tok, prevToken);
		if (!substitute)
			return undefined;
		const entry = row.get(substitute.type);
		return entry && { entry, tok: substitute };
	};

	const resolveSym = (sym: string|RegExp|Terminal|undefined): Terminal|undefined =>
		typeof sym === 'string'		? g.terminalsByName.get(literalPattern(sym))
		: sym instanceof RegExp		? g.terminalsByName.get(sym.source)
		: sym;


	const createTokenStream = (lexEntries: Terminal[], input: string) => {
		const lexState: LexState = { offset: 0, line: 1, col: 1 };
		let lookahead: Token | undefined;
		return {
			peek: (allowed?: Map<Terminal, ActionEntry>): Token => lookahead ??= nextToken(lexEntries, input, lexState, resolveSym, allowed),
			consume: () => { lookahead = undefined; }
		};
	};

	return {
		tables,
		parse: input => runParser(tables, createTokenStream(g.lexEntries, input), g.rules, recover, merge ?? {})
	};
}
