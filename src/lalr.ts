// ===================================================================
// LALR back end
// ===================================================================

import {
	GrammarBuilder, NonTerminal, InternalPredicate, Terminal, EOF, ERROR, ACCEPT, identityAction, nextToken, getTextPos,
	type ActionEntry, type GrammarSpec, type InternalRule, type InternalSym, type TextPos, type Token, type Parser, type MergeValues, type PrecEntry, type LexPosition,
} from './tison';

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

export interface LALRParser<T, C = any> extends Parser<T, C> {
	tables: ParseTables;
}

interface Lexer extends TextPos {
	prev?:		Token<any>;
	ctx:		any;			// reassigned when a GLR fork settles on a branch's cloned ctx
	next(allowed: Map<Terminal, ActionEntry>): 	Token<any>;
	peekText(): string;
}

// The token recovery is being asked to substitute for -- NOT reflected in `remaining`, since a real
// (already-lexed) token has already advanced the lexer's position past its own text by the time recovery
// runs. A callback checking "is the failing token itself `}`" needs this, not `remaining`.
export interface RecoveryLexPosition extends LexPosition {
    token: Terminal;
}

export type RecoveryCallback = (lex: RecoveryLexPosition, row: Map<Terminal, ActionEntry>) => Token | Terminal | string | RegExp | undefined;

interface StackEntry { state: number; value: unknown; }
type InternalRecoveryCallback = (stream: Lexer, row: Map<Terminal, ActionEntry>, failing: Terminal) => Token | undefined;

// Thrown by `runParser` in `prefixMode` when the stack has already fully reduced to `start` (the current state would accept a real `$end` right now)
// but the actual lookahead is something else -- i.e. a hand-parsed "island" (see `Manual()`) asked a sub-parser to consume just a bounded prefix of a larger
// string, and it found exactly one. Caught by `runParserPrefix`, never meant to escape it.
class PrefixAccepted {
	constructor(public value: unknown, public consumed: number) {}
}

// ===================================================================
//  Build Tables
// ===================================================================

// Every state must have an explicit entry for every `alwaysTerminals`/`alwaysSkip` terminal (so the
// lexer's candidate set is byte-identical everywhere), but the entries themselves are just the default
// 'error'/'ignore' wherever nothing more specific already won -- deterministic from the grammar alone,
// so `deserializeTables` reapplies this instead of `serializeTables` writing it to disk.
function fillAlwaysEntries(g: GrammarBuilder, action: Map<Terminal, ActionEntry>[]) {
	for (const row of action) {
		for (const term of g.alwaysTerminals) {
			if (!row.has(term))
				row.set(term, { kind: 'error' });
		}
		for (const term of g.alwaysSkip) {
			if (!row.has(term))
				row.set(term, { kind: 'ignore' });
		}
	}
}

// -- SLR(1)/LALR(1) table construction -------------------------------------
//
// Builds the LR(0) automaton, then (when `lalr`) computes per-state LALR(1) reduce lookaheads via
// fixed-point propagation over it, rather than the canonical-LR(1)-then-merge approach (avoids that
// method's state explosion). The propagation is monotone over a finite domain so it always terminates;
// `LALR_MAX_PASSES` is just a tripwire against that invariant ever breaking.
// `lalr: false` falls back to plain FOLLOW(lhs)-based SLR(1) lookaheads (weaker: more spurious
// conflicts, but no correctness difference since conflicts still resolve via precedence/GLR either way).


function buildLALR(g: GrammarBuilder, lalr = true): ParseTables {
	if (g.hasPredicates) {
		const bad = g.rules.find(r => r.rhs.some(s => s instanceof InternalPredicate))!;
		throw new Error(`And()/Not() are PEG-only and have no LR equivalent (rule '${bad.lhs.name} -> ${bad.rhs.map(s => s.name).join(' ')}'); build this grammar with makePegParser() instead`);
	}

	interface LR0Item { rule: number; dot: number; }
	const lr0Key = (i: LR0Item) => `${i.rule}:${i.dot}`;

	const lr0Closure = (items: LR0Item[]): LR0Item[] => {
		const inSet = new Set(items.map(lr0Key));
		const queue = [...items];
		for (const { rule, dot } of queue) {
			const B = g.rules[rule].rhs[dot];
			if (B instanceof NonTerminal) {
				for (const prod of g.rules) {
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
		return lr0Closure(items
			.filter(i => g.rules[i.rule].rhs[i.dot] === sym)
			.map(i => ({ rule: i.rule, dot: i.dot + 1 }))
		);
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
			.filter(i => i.dot < g.rules[i.rule].rhs.length)
			.map(i => g.rules[i.rule].rhs[i.dot]));
		for (const sym of syms) {
			const moved = lr0Goto(lr0States[si], sym);
			if (moved.length)
				lr0Trans[si].set(sym, addLR0State(moved));
		}
	}

	const numStates = lr0States.length;

	// -- FOLLOW sets (SLR(1) reduce lookaheads) ------------------------
	const follow = new Map<NonTerminal, Set<Terminal>>();
	for (const nt of new Set(g.rules.map(r => r.lhs)))
		follow.set(nt, new Set());

	for (let changed = true; changed; ) {
		changed = false;
		for (const rule of g.rules) {
			for (let i = 0; i < rule.rhs.length; i++) {
				const sym = rule.rhs[i];
				if (!(sym instanceof NonTerminal))
					continue;
				const followSym = follow.get(sym)!;

				let restNullable = true;
				for (let j = i + 1; j < rule.rhs.length; j++) {
					const sf = g.first.get(rule.rhs[j])!;
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
					const rule = g.rules[item.rule];
					const sym = rule.rhs[item.dot];
					if (sym === undefined)
						continue; // complete item -- nothing to propagate from here (handled as a reduce below)

					if (sym instanceof NonTerminal) {
						let restNullable = true;
						const firstOfRest = new Set<Terminal>();
						for (let j = item.dot + 1; j < rule.rhs.length; j++) {
							const sf = g.first.get(rule.rhs[j])!;
							for (const f of sf.terms)
								firstOfRest.add(f);
							if (!sf.nullable) {
								restNullable = false;
								break;
							}
						}
						const laForClosure = restNullable ? new Set([...firstOfRest, ...itemLA]) : firstOfRest;
						for (const prod of g.rules) {
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
			const r = g.rules[item.rule];
			if (item.dot < r.rhs.length) {
				const sym = r.rhs[item.dot];
				if (sym instanceof Terminal && !shiftRule[s].has(sym))
					shiftRule[s].set(sym, r);
			}
		}
		for (const [sym, target] of lr0Trans[s]) {
			if (sym instanceof Terminal)
				setAction(g, action[s], sym, sym === EOF ? { kind: 'accept' } : { kind: 'shift', state: target }, s, shiftRule[s].get(sym)?.prec, conflicts);
			else if (sym instanceof NonTerminal)
				goto[s].set(sym, target);
		}
		for (const item of lr0States[s]) {
			const r = g.rules[item.rule];
			if (item.dot >= r.rhs.length && r.lhs !== ACCEPT) {
				const lookaheads = lalr ? (lalrLA![s].get(lr0Key(item)) ?? new Set<Terminal>()) : follow.get(r.lhs)!;
				for (const la of lookaheads)
					setAction(g, action[s], la, { kind: 'reduce', rule: item.rule }, s, shiftRule[s].get(la)?.prec, conflicts);
			}
		}
	}
	fillAlwaysEntries(g, action);

	return {
		action,
		goto,
		rules:		g.rules,
		conflicts,
	};
}

// -- Conflict resolution (Bison rules) ---------------------------

function setAction(g: GrammarBuilder,
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
		const reducePrec	= g.rules[reduceEntry.rule].prec;

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
			const lost = g.rules[reduceEntry.rule];
			conflicts.push({ state, term, kind: 'auto', resolution: `shift (default, no prec info; loses reduce of rule ${lost.id}: ${lost.lhs.name} -> ${lost.rhs.map(s => s.name).join(' ')})` });
		}

	} else if (existing.kind === 'reduce' && incoming.kind === 'reduce') {
		if (g.rules[existing.rule].prec?.assoc === 'fork' || g.rules[incoming.rule].prec?.assoc === 'fork') {
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
//  Table (de)serialization
// ===================================================================
// `buildTables` (the LR(0)/LALR automaton construction) depends only on grammar *shape* -- which
// terminals/nonterminals appear where, precedence, `lalr`/`optimize` -- never on the action closures
// themselves. So a cache only needs `action`/`goto`; `rules` (which carries the live `.action` closures)
// is regenerated for free as a side effect of reconstructing `GrammarBuilder` from the spec, which
// callers must do anyway to get a fingerprint to validate the cache against.

export const TABLE_FORMAT_VERSION = 4;

// Rows are flat number arrays, not `[key, value]` pairs -- every terminal/nonterminal is already an
// index into a namespace `deserializeTables` reconstructs from the live `GrammarBuilder`, so nothing here is ever a string: entries are effectively
// tables of small integers, the same shape the built-in `Map`/`Terminal` objects hide.
//
// action row: `[...defaultEntry, ...(termIndex*2 | isException)*]` -- an instruction-set-sized grammar
// (hundreds of terminals) has states where nearly every terminal reduces by the *same* rule (e.g. "any
// terminal that can start another instruction"), so most of a row's entries are one repeated value.
// Rather than writing that value out per terminal, the row leads with its single most-common entry as
// a default (chosen by `serializeTables`, same shape as `encodeEntry` produces for any entry), then
// lists every terminal as just its tagged index: even (`i*2`) means "use the row default", odd
// (`i*2+1`) means an explicit entry follows, encoded the same way as the header. Genuinely dense/varied
// rows (e.g. WAT's ~25 "start of instruction" dispatch states, one real shift target per opcode) get
// no benefit from this -- nothing there repeats -- but cost only one extra number per entry to allow it.
// goto row: repeated (ntIndex, state) pairs.

const EntryTag = { Shift: 0, Reduce: 1, Accept: 2, Conflict: 3 } as const;

export interface SerializedTables {
	action:		number[][];
	goto:		number[][];
}

// Deterministic index for each NonTerminal, in first-encounter order over `g.rules`. NonTerminal
// identity (not `.name`) is what matters -- anonymous/inlined rules can share the literal name
// 'unknown name' -- but re-running `new GrammarBuilder(spec)` from the same spec always walks rules in
// the same order, so the indices line up again on reload.
function indexNonTerminals(g: GrammarBuilder): Map<NonTerminal, number> {
	const index = new Map<NonTerminal, number>();
	const add = (nt: NonTerminal) => { if (!index.has(nt)) index.set(nt, index.size); };
	for (const r of g.rules) {
		add(r.lhs);
		for (const sym of r.rhs) {
			if (sym instanceof NonTerminal)
				add(sym);
		}
	}
	return index;
}

// Terminal identity is already stable-and-unique by `.name` (see `GrammarBuilder`'s interning), so
// `g.terminalsByName`'s own (deterministic, insertion-ordered) iteration doubles as the index -- plus
// EOF/ERROR, the two terminals that live outside that map.
function terminalsByIndex(g: GrammarBuilder): Terminal[] {
	return [...g.terminalsByName.values(), EOF, ERROR];
}

function encodeEntry(out: number[], entry: ActionEntry) {
	switch (entry.kind) {
		case 'shift':		out.push(EntryTag.Shift, entry.state); break;
		case 'reduce':		out.push(EntryTag.Reduce, entry.rule); break;
		case 'accept':		out.push(EntryTag.Accept); break;
		case 'conflict':
			out.push(EntryTag.Conflict, entry.entries.length);
			for (const e of entry.entries)
				encodeEntry(out, e);
			break;
		// 'error'/'ignore' never reach here -- `serializeTables` filters them out below.
	}
}

// `cursor` is mutated in place so nested `conflict` entries can keep consuming from the same row.
function decodeEntry(row: number[], cursor: { i: number }): ActionEntry {
	switch (row[cursor.i++] as 0|1|2|3) {
		case EntryTag.Shift:	return { kind: 'shift', state: row[cursor.i++] };
		case EntryTag.Reduce:	return { kind: 'reduce', rule: row[cursor.i++] };
		case EntryTag.Accept:	return { kind: 'accept' };
		case EntryTag.Conflict: return { kind: 'conflict', entries: Array.from({ length: row[cursor.i++] }, () => decodeEntry(row, cursor)) };
	}
}

// 'error'/'ignore' entries are never anything but `fillAlwaysEntries`'s own default (see its comment) --
// skip them here, `deserializeTables` regenerates them instead of storing millions of redundant entries
// for grammars with large `alwaysTerminals`/`alwaysSkip` sets.
export function serializeTables(g: GrammarBuilder, tables: ParseTables): SerializedTables {
	const termIndex	= new Map(terminalsByIndex(g).map((t, i) => [t, i]));
	const ntIndex	= indexNonTerminals(g);
	return {
		action: tables.action.map(row => {
			const real = [...row]
				.filter(([, entry]) => entry.kind !== 'error' && entry.kind !== 'ignore')
				.map(([term, entry]) => ({ idx: termIndex.get(term)!, entry, key: JSON.stringify(entry) }));
			if (!real.length)
				return [];

			// Pick the entry (by structural value, not identity) that recurs most often in this row as
			// the default -- ties broken by first-seen, which only affects which encoding is chosen,
			// never correctness.
			const counts = new Map<string, { entry: ActionEntry; count: number }>();
			for (const { entry, key } of real) {
				const found = counts.get(key);
				if (found)
					found.count++;
				else
					counts.set(key, { entry, count: 1 });
			}
			let [best] = counts.values();
			for (const c of counts.values()) {
				if (c.count > best.count)
					best = c;
			}
			const defaultKey = JSON.stringify(best.entry);

			const out: number[] = [];
			encodeEntry(out, best.entry);
			for (const { idx, entry, key } of real) {
				if (key === defaultKey) {
					out.push(idx * 2);
				} else {
					out.push(idx * 2 + 1);
					encodeEntry(out, entry);
				}
			}
			return out;
		}),
		goto: tables.goto.map(row => {
			const out: number[] = [];
			for (const [nt, state] of row)
				out.push(ntIndex.get(nt)!, state);
			return out;
		}),
	};
}


// `g` must come from a fresh `new GrammarBuilder(spec)` for the *same* spec the tables were serialized
// from -- that's what supplies both the live `.action` closures (via `g.rules`) and the terminal/index
// namespaces the serialized rows were written against. The returned `conflicts` is always `[]` (see the
// comment on `TABLE_FORMAT_VERSION`) -- callers that want real conflict diagnostics need an uncached
// `g.buildTables(...)`.
export function deserializeTables(g: GrammarBuilder, s: SerializedTables): ParseTables {
	const termByIndex	= terminalsByIndex(g);
	const ntByIndex		= [...indexNonTerminals(g).entries()].sort((a, b) => a[1] - b[1]).map(([nt]) => nt);
	const action = s.action.map(row => {
		const m = new Map<Terminal, ActionEntry>();
		if (!row.length)
			return m;
		const cursor = { i: 0 };
		const defaultEntry = decodeEntry(row, cursor);
		while (cursor.i < row.length) {
			const tagged	= row[cursor.i++];
			m.set(termByIndex[tagged >> 1], (tagged & 1) ? decodeEntry(row, cursor) : defaultEntry);
		}
		return m;
	});
	fillAlwaysEntries(g, action);
	return {
		action,
		goto: s.goto.map(row => {
			const m = new Map<NonTerminal, number>();
			for (let i = 0; i < row.length; i += 2)
				m.set(ntByIndex[row[i]], row[i + 1]);
			return m;
		}),
		rules:		g.rules,
		conflicts:	[],
	};
}

// A plain JSON-serializable snapshot of everything that can affect `buildTables`'s output. Callers hash
// this (e.g. sha256 of `JSON.stringify(...)`) to decide whether a cached `SerializedTables` is still
// valid for the current grammar -- cheaper and more robust than a source-file mtime check, since it
// also catches grammar-equivalent edits (renames, reformatting) that don't need to invalidate the cache,
// and is naturally versioned via TABLE_FORMAT_VERSION for engine-side algorithm changes.
export function grammarFingerprint(g: GrammarBuilder, spec: GrammarSpec<any>): unknown {
	const ntIndex = indexNonTerminals(g);
	const symKey = (sym: InternalSym): string =>
		sym instanceof Terminal				? `t:${sym.name}`
		: sym instanceof InternalPredicate	? `p:${sym.negate ? '!' : '&'}${symKey(sym.sym)}`
		: `n:${ntIndex.get(sym)}`;
	return {
		version:			TABLE_FORMAT_VERSION,
		terminals:			[...g.terminalsByName.values()].map(t => [t.name, t.pattern?.source ?? null]),
		alwaysTerminals:	g.alwaysTerminals.map(t => t.name),
		alwaysSkip:			g.alwaysSkip.map(t => t.name),
		rules:				g.rules.map(r => [symKey(r.lhs), r.rhs.map(symKey), r.prec ?? null]),
	};
}

// ===================================================================
//  Parser
// ===================================================================

function runParser(tables: ParseTables, stream: Lexer, ctx: any, recover: InternalRecoveryCallback, merge: MergeValues, forkCtx: (ctx: any) => any, prefixMode?: boolean) {
	const stack: StackEntry[] = [{ state: 0, value: undefined }];

	let realTok		= stream.next(tables.action[0]);
	let recoveryStuckAt: number | undefined;
	let recoveryStuckCount = 0;
	const MAX_RECOVERY_AT_SAME_OFFSET = 50;

	while (true) {
		const row			= tables.action[stack[stack.length - 1].state];
		const direct		= row.get(realTok.type);
		let usingRecovery	= !direct || direct.kind === 'error';
		// In prefix mode, a real lookahead that doesn't fit here doesn't necessarily mean "done" yet -- a
		// grammar shaped so nothing legally follows `start` gates even its *own* final reduce(s) on lookahead
		// `$end` (that's exactly what `start`'s FOLLOW set is, with no real continuation to share it with), so
		// reaching actual accept can take several chained reduces from here. Drive those via a synthetic `$end`
		// token through the ordinary reduce/goto path below (not `recover()` -- this isn't error recovery,
		// every one of these reduces was always going to happen, just deferred) until genuine accept, or a
		// state with no `$end` entry at all (a real dead end, falls through to the ordinary error below).
		const syntheticEnd	= prefixMode && usingRecovery && row.has(EOF);
		if (usingRecovery && !syntheticEnd) {
			// Not reset on non-recovery steps: a stuck cycle alternates recovery with shift/reduce of the
			// synthesized token itself, so consecutive recovery steps are rare even when truly stuck --
			// compare against `stream.offset` (real progress) instead.
			recoveryStuckCount = recoveryStuckAt === stream.offset ? recoveryStuckCount + 1 : 1;
			recoveryStuckAt = stream.offset;
			// Recovery keeps synthesizing tokens without ever consuming real input: give up on it so this
			// falls through to the ordinary Unexpected-token/character report below, instead of spinning.
			if (recoveryStuckCount > MAX_RECOVERY_AT_SAME_OFFSET)
				usingRecovery = false;
		}
		const tok			= !usingRecovery ? realTok : syntheticEnd ? { type: EOF, value: '', pos: realTok.pos } : recover(stream, row, realTok.type);
		const entry			= tok && row.get(tok.type);

		if (!entry || entry.kind === 'error') {
			const expected	= [...row].filter(([k, v]) => k !== EOF && v.kind !== 'error' && v.kind !== 'ignore').map(([k]) => k.name);
			throw new SyntaxError(
				(realTok.type !== ERROR ? `Unexpected token '${realTok.type.name}'` : `Unexpected character '${stream.peekText()[0] ?? ''}'`)
				+ ` at line ${stream.line}, col ${stream.col}. `
				+ `Expected: ${expected.length ? expected.join(', ') : '(nothing)'}`
			);
		}

		if (entry.kind === 'conflict') {
			const result = runGlrFork(tables, stream, tok, ctx, recover, stack, merge, forkCtx);
			if (result.accepted)
				return result.value as any;
			ctx = stream.ctx = result.ctx;
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
			const state		= tables.goto[topState].get(rule.lhs);
			if (state === undefined)
				throw new Error(`No GOTO entry for state ${topState}, non-terminal '${rule.lhs.name}'`);

			stack.push({ state, value: rule.action(vals, ctx) });

		} else if (entry.kind === 'accept') {
			// Reached via a synthetic `$end` (the real lookahead is something else) -- report the boundary
			// instead of pretending the rest of `stream` doesn't exist.
			if (prefixMode && realTok.type !== EOF)
				throw new PrefixAccepted(stack[stack.length - 1].value, realTok.pos.offset);
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

type GlrForkResult = { accepted: true; value: unknown } | { accepted: false; ctx: any };

// On a non-accepting return, `stack` has been overwritten in place with the settled single derivation,
// and `ctx` is the winning branch's context (a `forkCtx` clone when that hook is set).
function runGlrFork(tables: ParseTables, stream: Lexer, tok: Token, ctx: any, recover: InternalRecoveryCallback, stack: StackEntry[], merge: MergeValues, forkCtx: (ctx: any) => any): GlrForkResult {

	interface StackFrame extends StackEntry {
		id:		number;			// identifies this exact frame, for convergence keys below
		parent: StackFrame | null;
		ctx:	any;			// this derivation path's context; only the top frame's is live
	}

	let frameIdCounter	= 0;
	let accepted		= false;
	let acceptedValue: unknown;

	const makeFrame		= (parent: StackFrame | null, state: number, value: unknown, pathCtx: any) => ({ id: frameIdCounter++, parent, state, value, ctx: pathCtx });
	const convergeKey	= (top: StackFrame) => `${top.state}:${top.parent ? top.parent.id : -1}`;
	// Converging paths may carry different ctx clones; the already-registered path's ctx wins.
	const mergeInto		= (into: StackFrame, incoming: StackFrame, ruleId?: number) =>
		makeFrame(into.parent, into.state, ((ruleId !== undefined ? tables.rules[ruleId].merge : undefined) ?? merge)(into.value, incoming.value), into.ctx);

	// Flat stack -> frame chain
	let frame = makeFrame(null, stack[0].state, undefined, ctx);
	for (let i = 1; i < stack.length; i++)
		frame = makeFrame(frame, stack[i].state, stack[i].value, ctx);

	let active = new Map([[convergeKey(frame), frame]]);

	// Bounds all work across this call (any cause of runaway path explosion), on top of the more specific recovery-stuck check below.
	// 5,000 (the original bound) turned out too tight for legitimate, real-world-complex code -- not a bug, just under-provisioned:
	// two real files (msbuild/src/MsBuild.ts, this repo's own transform.ts) genuinely need >5,000 but <10,000 steps to resolve a
	// single big function's worth of ordinary ambiguity (switch/case + optional chaining + generic types, each contributing a
	// small amount that adds up), and take single-digit milliseconds even at 50,000 -- a true runaway explosion multiplies per
	// token and would blow past this by orders of magnitude almost immediately, so the higher bound still catches those.
	let totalWork = 0;
	const MAX_TOTAL_WORK = 50_000;

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

		const applyAction = (path: StackFrame, entry: ActionEntry, actionTok: Token, stayAtSamePosition: boolean, pathCtx: any) => {
			if (entry.kind === 'shift') {
				const top = makeFrame(path, entry.state, actionTok.value, pathCtx);
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
				const reducedValue	= rule.action(vals, pathCtx);
				const nextState		= tables.goto[top.state]?.get(rule.lhs);
				if (nextState !== undefined)
					registerAtPosition(makeFrame(top, nextState, reducedValue, pathCtx), entry.rule);

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
				throw new SyntaxError(
					`GLR fork exceeded ${MAX_TOTAL_WORK} total steps resolving ambiguity at line ${stream.line}, col ${stream.col} `
					+ `-- likely runaway path explosion, not genuine ambiguity (this is a parser/grammar bug, not just invalid input).`
				);
			}
			const path	= worklist.shift()!;
			// A frame superseded by a later merge at the same key is a dead end: skip it, since the merged successor (already on the worklist) carries the real value.
			if (active.get(convergeKey(path)) !== path)
				continue;

			const row			= tables.action[path.state];
			const direct		= row.get(tok.type);
			let usingRecovery	= !direct || direct.kind === 'error';
			// Same non-progress hazard as runParser (see there): once recovery has churned without this
			// position ever advancing, stop trying it so the path just dies out normally below instead
			// of every worklist entry re-triggering this same throw.
			if (usingRecovery && ++recoveryUsedCount > MAX_RECOVERY_PER_POSITION)
				usingRecovery = false;
			const actionTok		= usingRecovery ? recover(stream, row, tok.type) : tok;
			const entry			= actionTok && row.get(actionTok.type);
			if (entry && entry.kind !== 'error') {
				if (entry.kind === 'conflict') {
					// Every branch gets its own clone, leaving `path.ctx` (the original on the first
					// fan-out) unmutated -- the lexer keeps reading it until the fork settles.
					for (const inner of entry.entries)
						applyAction(path, inner, actionTok, actionTok != tok, forkCtx(path.ctx));
				} else {
					applyAction(path, entry, actionTok, actionTok != tok, path.ctx);
				}
			}
		}

		if (accepted)
			return { accepted: true, value: acceptedValue };

		if (tok.type === EOF)
			throw new SyntaxError(`Unexpected end of input at line ${stream.line}, col ${stream.col} -- input ended before any active derivation reached an accepting state (likely truncated or missing a closing token, e.g. an unclosed tag/bracket).`);

		if (tok.type !== ERROR)
			stream.prev = tok;

		// Merge converging paths landing on i + 1 (same derivation reached by separate shifts).
		if (!shifted.length) {
			if (tok.type === ERROR)
				throw new SyntaxError(`Unexpected character '${stream.peekText()[0] ?? ''}' at line ${stream.line}, col ${stream.col}.`);
			// Genuinely ambiguous phrasing on purpose: every forked derivation dying here can mean a real grammar
			// gap, but empirically (see tison_official_ts_test_suite memory) is at least as often just invalid
			// input no derivation could ever have accepted (a mismatched/unclosed tag, a malformed attribute) --
			// unlike the ERROR-token case above, there's no cheap way to tell those apart from here.
			throw new SyntaxError(`No active GLR fork paths survived to token ${i + 1} (at line ${stream.line}, col ${stream.col}, near '${tok.type.name}') -- every forked derivation died out here, from either a parser/grammar gap or input no derivation could accept.`);
		}

		active = new Map<string, StackFrame>();
		for (const path of shifted) {
			const key		= convergeKey(path);
			const existing	= active.get(key);
			active.set(key, existing ? mergeInto(existing, path) : path);
		}

		// Settled back down to a single derivation -- hand it back to runParser's fast loop
		if (active.size === 1) {
			const [winner] = active.values();
			const frames: StackEntry[] = [];
			for (let frame: StackFrame | null = winner; frame; frame = frame.parent)
				frames.push({ state: frame.state, value: frame.value });
			stack.length = 0;
			for (let i = frames.length - 1; i >= 0; i--)
				stack.push(frames[i]);
			return { accepted: false, ctx: winner.ctx };
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

// Combines two GLR derivation paths that converged onto the same state+parent (see `runGlrFork`). Two paths
// converging on an identical value aren't a real ambiguity (same parse reached two ways) so collapse rather
// than accumulate an array.
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b))
		return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
		return false;
	if (a instanceof RegExp || b instanceof RegExp)
		return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
	if (Array.isArray(a) || Array.isArray(b))
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
	const keysA = Object.keys(a);
	return keysA.length === Object.keys(b).length && keysA.every(k => sameValue((a as any)[k], (b as any)[k]));
}

export interface LALROptions {
	slr?:		        boolean;
	optimize?:	        boolean;		// default true: bypass pass-through unit-rule GOTO hops in the built tables (see eliminateUnitGotos); set false to parse with the raw tables when debugging a suspect parse
	recover?:		    RecoveryCallback;
	merge?:			    MergeValues;
	forkCtx?:		    (ctx: any) => any;	// clone ctx per GLR fork branch so dying branches' action mutations can't leak; the winner's clone is adopted when the fork settles. Lexing during a fork still sees the pre-fork ctx.
    prebuiltBuilder?:   GrammarBuilder;
    prebuiltTables?:    ParseTables;
}


export function makeParser<T>(spec: GrammarSpec<T>, options: LALROptions = {}): LALRParser<T> {
	const g			= options.prebuiltBuilder ?? new GrammarBuilder(spec);
	const tables	= options.prebuiltTables ?? (() => {
		const tables = buildLALR(g, !options.slr);
		if (options.optimize !== false)
			eliminateUnitGotos(tables);
		return tables;
	})();

	const resolveSym = (sym: Token<any>|Terminal|string|RegExp|undefined): Token<any>|Terminal|undefined =>
		typeof sym === 'string'		? g.terminalsByName.get(sym)
		: sym instanceof RegExp		? g.terminalsByName.get(sym.source)
		: sym;

	const makeLexer = (input: string, ctx: any) => ({
		offset:	0,
		line:	1,
		col:	1,
		ctx,
		next(allowed: Map<Terminal, ActionEntry>) { return nextToken(allowed, input, this, this.ctx, resolveSym); },
		peekText() { return input.substring(this.offset); }
	});

	const recover: InternalRecoveryCallback = options.recover
		? (stream, row, failing) => {
			const result = resolveSym(options.recover!({...getTextPos(stream), remaining: stream.peekText(), prev: stream.prev, token: failing}, row));
			if (result)
				return result instanceof Terminal ? {type: result, value: '', pos: getTextPos(stream)} : result;
			return undefined;
		}
		: (_stream, _row) => undefined;

	const merge: MergeValues = options.merge ?? ((left, right) => {
		if (Array.isArray(left))
			return left.some(v => sameValue(v, right)) ? left : [...left, right];
		return sameValue(left, right) ? left : [left, right];
	});

	const forkCtx = options.forkCtx ?? (ctx => ctx);

	return {
		tables,
		parse: (input, ctx) => runParser(tables, makeLexer(input, ctx), ctx, recover, merge, forkCtx),
		parsePrefix: (input, ctx) => {
			try {
				const stream = makeLexer(input, ctx);
				return { value: runParser(tables, stream, ctx, recover, merge, forkCtx, true), consumed: stream.offset };
			} catch (e) {
				if (e instanceof PrefixAccepted)
					return { value: e.value, consumed: e.consumed };
				throw e;
			}
		}
	};
}
