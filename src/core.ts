// core.ts -- grammar spec types, the lexer, and GrammarBuilder: the shared foundation for both back ends
// (LALR in lalr.ts, PEG in peg.ts). Kept free of imports from either so tison.ts can barrel all three
// without a cycle.

// terminals are regexes with `Terminal.lex` callbacks
// `Manual()` islands, `skip`, and semantic actions
// (`$[i]` indexing, `ctx`).

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

// A literal that ends in a word character (e.g. 'var_decl', 'in') is given an implicit trailing word-boundary, so it can never match as a strict prefix of a longer word
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

export interface Token<T = string> {
	type:	Terminal<T>;
	value:	T;	// semantic value; available as $[i] in actions
	pos:	TextPos;
	// Extra raw characters already consumed beyond the terminal's own regex match, for a callback that hand-
	// parses more than its trigger pattern (see `Manual()`) -- `nextToken` advances the lexer past match.length
	// + consumed instead of just match.length once such a callback returns.
	consumed?: number;
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


export type TerminalCallback<T = any, C = any> = (lexctx: LexContext, ctx: C) => Token<T> | Terminal<T> | string | RegExp | undefined;

export class Terminal<T = any> {
	_ignore = false;
	pattern?: RegExp;
	constructor(public name: string, pattern?: RegExp, public callback?: TerminalCallback<T>) {
		if (pattern)
			this.pattern = new RegExp(pattern.source, 'y' + pattern.flags.replace(/[gyd]/g, ''));
	}
}

export function termOneOf<const T extends string>(names: readonly T[]) {
	const sorted = [...names].sort((a, b) => b.length - a.length);
	return new Terminal<T>(names.join('|'), RegExp(sorted.map(literalPattern).join('|')));
}

export function terminal(name: string, pattern?: RegExp, lex?: TerminalCallback) {
	return new Terminal<string>(name, pattern, lex);
}

// A hand-parsed "island": `trigger` only decides *whether* this terminal fires at a position (kept small and
// unambiguous, e.g. a single sigil like `/@/`), then `fn` gets the raw remaining input from right after that
// trigger match and does its own parsing however it likes (regex, a hand-rolled scanner, even invoking a
// second tison `Parser` built with `start` set to some existing nonterminal) -- entirely outside the LALR
// table, so it can never disturb states shared with unrelated grammar positions the way a new rule reaching
// an already-overloaded nonterminal can (see tison_debugging_technique memory, "sixth"/"seventh" class).
// `fn` returns how many characters of `remaining` it consumed; the lexer advances past trigger + that span
// as one token, whose value is the payload `fn` already fully parsed -- not further reduced by any grammar rule.
export function Manual<T>(name: string, trigger: RegExp, fn: (remaining: string, ctx: any) => { value: T; consumed: number } | undefined): Terminal<T> {
	const term: Terminal<T> = new Terminal<T>(name, trigger, (lex, ctx) => {
		const r = fn(lex.remaining, ctx);
		return r && { type: term, value: r.value, pos: lex, consumed: r.consumed };
	});
	return term;
}

// A syntactic predicate: matches (or, negated, refuses to match) `sym` without consuming any input.
// PEG-only -- there's no LR equivalent, so `buildTables` rejects a grammar containing one.
export class Predicate<T = undefined> {
	declare readonly _value: T;	// phantom: only carries the predicate's value type for `ElemValue`
	constructor(public negate: boolean, public sym: GrammarSym) {}
}
// `&sym`: succeeds where `sym` would, consuming nothing. Its value is `sym`'s.
export function And<const S extends GrammarSym>(sym: S) {
	return new Predicate<ElemValue<S>>(false, sym);
}
// `!sym`: succeeds exactly where `sym` would fail, consuming nothing. Its value is always `undefined`.
export function Not(sym: GrammarSym) {
	return new Predicate(true, sym);
}

export type Action<T, C = any, A = any[]> = (values: WithTextPos<A>, ctx: C) => T
type GrammarSym<C = any> = string | RegExp | Terminal | Rules<any> | (()=>Rules<any>) | Ref<any> | Predicate<any> | Action<any, C>;

export type ElemValue<S> = S extends Rule2<infer U>[] ? U
	: S extends RegExp ? string
	: S extends Terminal<infer U> ? U
	: S extends Predicate<infer U> ? U
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
	merge?:		MergeValues;
}

export function WithPrec<T>(rule: Rule<T>, prec: Precedence): Rule<T> {
	return {...rule, prec};
}
export function WithMerge<T>(rule: Rule<T>, merge: MergeValues): Rule<T> {
	return {...rule, merge};
}
export function ForceFork<T>(rule: Rule<T>): Rule<T> {
	return {...rule, prec: forceFork};
}

export type CommonAction<C> = <T>(value: T, values: WithTextPos<any[]>, ctx: C)=>any
export function withCommonAction<C>(commonAction: CommonAction<C>, action: <T>(values: WithTextPos<any[]>, ctx: C) => T) {
	return (values: WithTextPos<any[]>, ctx: C) => commonAction(action(values, ctx), values, ctx);
}
export function maybeCommonAction<C>(commonAction: CommonAction<C> | undefined) {
	return commonAction
		? (action: <T>(values: WithTextPos<any[]>, ctx: C) => T) => (values: WithTextPos<any[]>, ctx: C) => commonAction(action(values, ctx), values, ctx)
		: (action: <T>(values: WithTextPos<any[]>, ctx: C) => T) => action;
}

export function Rule<const R extends readonly GrammarSym[]>(rhs: R): Rule<ElemValue<R[0]>>;
export function Rule<T, const R extends readonly GrammarSym[], C = any>(rhs: R, action: Action<T, C, ValuesOf<R>>): Rule<T>;
export function Rule(rhs: GrammarSym[], action?: Action<any, any>) {
	return { rhs, action };
}

// Pins `ctx`'s type to `C` for every rule built with the returned function
export function makeRule<C>(commonAction?: CommonAction<C>) {
	const common = maybeCommonAction(commonAction);
	function rule<const R extends readonly GrammarSym<C>[]>(rhs: R): Rule<ElemValue<R[0]>>;
	function rule<T, const R extends readonly GrammarSym<C>[]>(rhs: R, action: Action<T, C, ValuesOf<R>>): Rule<T>;
	function rule(rhs: GrammarSym[], action?: Action<any, any>) {
		return { rhs, action: action ? common(action) : undefined };
	}
	return rule;
}

type Rule2<T> = Rule<T> | Rules<T> | (()=>Rules<T>)
export type Rules<T> = Rule2<T>[]

export function Rules<T>(...alts: [(self: () => Rules<T>) => Rules<T>] | Rules<T>): Rules<T>;
export function Rules(...params: any[]) {
	if (params.length === 1 && typeof params[0] === 'function' && !has0args(params[0])) {
		const rules: any = params[0](() => rules);
		return rules;
	}
	return params;
}

export function removeRules(rules: Rules<any>, pred: (rhs: GrammarSym[]) => boolean) {
	for (let i = rules.length - 1; i >= 0; i--) {
		const rule = rules[i];
		if (Array.isArray(rule) || typeof rule === 'function')
			continue;
		if (pred(rule.rhs))
			rules.splice(i, 1);
	}
}

export function Maybe<T>(rule: Rules<T>) {
	return Rules(
		Rule([], () => undefined),
		rule,
	);
}

export function List<T>(single: Rules<T> | (()=>Rules<T>), sep?: GrammarSym, trailing?: boolean) {
	return Rules<T[]>(self => [
		Rule([single], $ => [$[0]]),
		sep
			? Rule([self, sep, single] as const,	$ => [...($[0] as T[]), $[2]])
			: Rule([self, single] as const,			$ => [...($[0] as T[]), $[1]]),
		...(sep && trailing ? [Rule([self, sep] as const, $ => $[0] as T[])] : []),
	]);
}

export function MaybeList<T>(rule: Rules<T> | (()=>Rules<T>), sep?: GrammarSym, trailing?: boolean) {
	return Rules(
		List(rule, sep, trailing),
		Rule([], () => []),
	);
}

export function OneOf<const T extends string>(names: readonly T[]) {
	return Rules(...names.map(name => Rule([name]))) as Rules<T>;
}

export type TermLike = RegExp | string | Terminal;
export type MergeValues = (left: unknown, right: unknown) => unknown;

export interface GrammarSpec<T = any> {
	precedence?:	Record<string, Assoc | PrecEntry>;
	start?:			Rules<T>;		// defaults to the first value of `rules`
	rules?:			Record<string, Rules<any>>;
	skip?:			TermLike[];
	terminals?:		TermLike[];
}

export interface Parser<T, C = any> {
	parse(input: string, ctx?: C): T;
	// Like `parse`, but succeeds on a leading prefix of `input` that forms one complete derivation of
	// `start`, instead of requiring the rest of `input` to be consumed too -- for a sub-parser invoked from
	// inside a `Manual()` island that only wants "the next one of these", not "the rest of the file".
	parsePrefix(input: string, ctx?: C): { value: T; consumed: number };
}

// ===================================================================
//  Internal representation
// ===================================================================

/** @internal */
export class NonTerminal {
	constructor(public name: string) {}
}

/** @internal */
export class InternalPredicate {
	constructor(public negate: boolean, public sym: InternalSym) {}
	get name(): string { return (this.negate ? '!' : '&') + this.sym.name; }
}

/** @internal */ export type InternalSym = Terminal | NonTerminal | InternalPredicate;

/** @internal */ export const EOF		= new Terminal('$end');
/** @internal */ export const ERROR		= new Terminal('$error');
/** @internal */ export const ACCEPT	= new NonTerminal('$accept');
/** @internal */ export const identityAction: Action<unknown> = values => values[0];

export interface InternalRule {
	id:			number;
	lhs:		NonTerminal;
	rhs:		InternalSym[];
	action: 	Action<unknown>;
	prec?:		PrecEntry;
	peek?:		number;		// extra preceding stack values to pass to `action` without popping them (mid-rhs actions: values of the symbols before them in the containing rule)
	merge?:		MergeValues;	// GLR convergence combiner for this rule's ambiguous reduce, carried over from the user Rule
}

export type ActionEntry =
	| { kind: 'shift';	state:	number }
	| { kind: 'reduce'; rule:	number }
	| { kind: 'accept' }
	| { kind: 'ignore' }
	| { kind: 'error' }
	| { kind: 'conflict'; entries: ActionEntry[] }



// ===================================================================
//  Grammar builder
// ===================================================================

export class GrammarBuilder {
	rules:				InternalRule[] = [];
	alwaysTerminals:	Terminal[] = [];
	alwaysSkip:			Terminal[] = [];
	terminalsByName	= new Map<string, Terminal>();
	hasPredicates	= false;	// grammar uses And()/Not(), so it's PEG-only

	first	= new Map<InternalSym, { terms: Set<Terminal>; nullable: boolean }>();
	/** @internal */ readonly startSymbol: NonTerminal;

	constructor(spec: GrammarSpec<any>) {
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

		const resolveSym = (sym: GrammarSym, i: number): InternalSym =>
			typeof sym === 'string'		? nonTerminalsByName.get(sym) ?? internTerminal(sym, new RegExp(literalPattern(sym)))
			: typeof sym === 'function'	? (has0args(sym) ? internByRules(sym()) : anon(sym, i))
			: sym instanceof RegExp		? internTerminal(sym.source, sym)
			: sym instanceof Terminal	? this.terminalsByName.get(sym.name) ?? addTerminal(sym)
			: sym instanceof Predicate	? predicate(sym, i)
			: 'ref' in sym				? nonTerminalsByName.get(sym.ref)!
			: internByRules(sym)!;

		// A predicate consumes nothing, so it contributes nothing to FIRST and is trivially nullable --
		// enough to keep the fixed point below well-defined; `buildTables` rejects the grammar outright.
		const predicate = (p: Predicate<any>, i: number) => {
			const ip = new InternalPredicate(p.negate, resolveSym(p.sym, i));
			this.first.set(ip, { terms: new Set(), nullable: true });
			this.hasPredicates = true;
			return ip;
		};

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

}

// ===================================================================
//  Parser runtime
// ===================================================================

/** @internal */
export function getTextPos(x: TextPos) {
	return {offset: x.offset, line: x.line, col: x.col };
}

/** @internal */
export function advancePos(state: TextPos, text: string) {
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

/** @internal */
export function nextToken(allowed: Map<Terminal, ActionEntry>, input: string, state: TextPos & { prev?: Token }, ctx: any, resolveSym: (sym: Token<any>|Terminal|string|RegExp|undefined) => Token<any>|Terminal|undefined): Token<any> {

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
					// A callback returning a `Token` with `.consumed` set has hand-parsed past its own trigger
					// match (see `Manual()`) -- advance the real lexer position over that extra span too, not
					// just `match`, so the next real token is lexed from where the callback actually left off.
					const extra = !(result instanceof Terminal) && result.consumed
						? input.slice(after.offset, after.offset + result.consumed) : '';
					advancePos(state, match + extra);
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
