// ===================================================================
// PEG (parsing expression grammar) back end
// ===================================================================

// `makePegParser` reads the spec as a parsing expression grammar and returns a packrat recursive-descent parser:
// a nonterminal's alternatives become an *ordered* choice (first one that matches wins, no backtracking
// into it afterwards), so nothing is ever ambiguous and there are no conflicts to resolve.
//
// What carries over from the LR back end, unchanged: `Rule`/`Rules`/`List`/`Maybe`/..., terminals as
// regexes, `Terminal.lex` callbacks, `Manual()` islands, `skip`, and semantic actions (same `$[i]`
// indexing, same `ctx`). Two things are PEG-only -- `And()`/`Not()` syntactic predicates (rejected by
// `buildTables`), and PEG's greedy repetition, which the existing `List`/`MaybeList` helpers already give.
//
// Differences a grammar written for the LR back end will notice:
//   - `precedence` still works, via precedence climbing while growing a left-recursive seed (see
//     `matchNonTerminal`) -- so the README's `expr '+' expr` style grammar parses correctly here too.
//   - Only *direct* left recursion (`A -> A ...`) is supported; an indirect left-recursive cycle would
//     recurse forever, so it's detected up front and reported (see `leftRecursionProblems`).
//   - Semantic actions run speculatively: an alternative that matches and is then abandoned by an outer
//     failure has already run its actions. Keep actions free of side effects on anything but their own
//     return value (mutating `ctx` from an action is safe under LR, but not here).
//   - `$.pos` is the *start* of the matched text, not the LR back end's following-token position.

import {
	GrammarBuilder, NonTerminal, InternalPredicate, Terminal, EOF, ERROR, nextToken, getTextPos,
	type ActionEntry, type GrammarSpec, type InternalRule, type InternalSym, type TextPos, type Token, type Parser,
} from './tison';

export interface PegOptions {
	// How a terminal is matched at a position.
	//   'maxmunch' (default) -- lex one token from *all* the grammar's terminals, longest match wins, then
	//     check it's the terminal wanted. Identical tokenization to the LR back end (so keyword-vs-identifier
	//     resolves the same way), minus its state-restricted narrowing of the candidate set.
	//   'direct' -- try only the wanted terminal's own pattern, true scannerless PEG. Ordered choice then
	//     decides what a piece of text is, so `Not(KEYWORD)` guards replace maximal munch.
	lex?:		'maxmunch' | 'direct';
	memo?:		boolean;	// default true: packrat memoization, linear time at the cost of holding every (rule, position) result
	maxDepth?:	number;		// default 2000: recursion-depth tripwire, so a runaway grammar throws instead of blowing the JS stack
}

export interface PegParser<T, C = any> extends Parser<T, C> {
	grammar: GrammarBuilder;
}

// A position in the input, plus the last token consumed to reach it (`Terminal.lex` callbacks read it as
// `lex.prev`). Positions are values here, never mutated -- backtracking is just keeping the older one.
interface Pos extends TextPos {
	prev?: Token;
}
interface Match {
	value:	unknown;
	pos:	Pos;
	start:	TextPos;	// where the *consumed* text begins -- past any skipped whitespace, unlike `pos` on entry
}

const NO_PREC = Number.POSITIVE_INFINITY;

// A rule with no usable precedence always applies, at any minimum level -- it's a primary/base
// alternative, not an operator. `forceFork` is an LR conflict annotation, not a real level, so it counts
// as "no precedence" too rather than pinning the rule to level 0.
function levelOf(r: InternalRule) {
	return r.prec && r.prec.assoc !== 'fork' ? r.prec.level ?? 0 : NO_PREC;
}

// The minimum precedence level for a *trailing* self-reference (`A -> A '+' A`, `A -> '-' A`): one above
// this rule's own level for a left-associative operator, so a same-level operator can't be swallowed by
// the right operand and has to be picked up by the next round of seed growing instead; equal for a
// right-associative one, so it can. Undefined when the rule doesn't end in a self-reference at all.
function trailingMinPrec(r: InternalRule) {
	const level = levelOf(r);
	return level !== NO_PREC && r.rhs.length > 1 && r.rhs[r.rhs.length - 1] === r.lhs
		? level + (r.prec!.assoc === 'right' ? 0 : 1)
		: undefined;
}

// ===================================================================
//  Static grammar analysis
// ===================================================================

interface Analysis {
	alts:		Map<NonTerminal, InternalRule[]>;	// ordered choice, epsilon alternatives normalized to last
	direct:		Map<NonTerminal, InternalRule[]>;	// the `A -> A ...` subset of `alts`, in the same order
	base:		Map<NonTerminal, InternalRule[]>;	// the rest of `alts`, in the same order
	anon:		Map<NonTerminal, InternalRule>;		// mid-rule action nonterminals (empty rhs + `peek`)
	problems:	string[];	// 'error: ...' (fatal) and 'warning: ...' (a likely latent bug, still built)
}

function nullableSyms(g: GrammarBuilder) {
	const nullable = new Set<NonTerminal>();
	const isNullable = (s: InternalSym): boolean =>
		s instanceof InternalPredicate ? true : s instanceof NonTerminal ? nullable.has(s) : false;

	for (let changed = true; changed;) {
		changed = false;
		for (const r of g.rules) {
			if (!nullable.has(r.lhs) && r.rhs.every(isNullable)) {
				nullable.add(r.lhs);
				changed = true;
			}
		}
	}
	return isNullable;
}

// Nonterminals reachable at the *left corner* of `nt` -- i.e. entered without consuming any input first,
// which is exactly what makes left recursion non-terminating for a recursive-descent parser. A predicate
// consumes nothing either way, so it contributes both its own operand and whatever follows it.
function leftCorners(g: GrammarBuilder, isNullable: (s: InternalSym) => boolean) {
	const edges = new Map<NonTerminal, Set<NonTerminal>>();
	// A left-corner edge that isn't simply `rhs[0]` -- reached past a nullable prefix, so seed growing
	// (which binds `rhs[0]` to the seed) can't express it. Kept to explain the rejection.
	const indirect = new Map<NonTerminal, InternalRule>();

	for (const r of g.rules) {
		let set = edges.get(r.lhs);
		if (!set)
			edges.set(r.lhs, set = new Set());
		for (let i = 0; i < r.rhs.length; i++) {
			const sym	= r.rhs[i];
			const inner	= sym instanceof InternalPredicate ? sym.sym : sym;
			if (inner instanceof NonTerminal) {
				set.add(inner);
				if (inner === r.lhs && !(i === 0 && sym === inner) && !indirect.has(r.lhs))
					indirect.set(r.lhs, r);
			}
			if (!isNullable(sym))
				break;
		}
	}
	return { edges, indirect };
}

// Tarjan, iterative -- a deep grammar would otherwise recurse as deep as its left-corner graph.
function stronglyConnected(nodes: NonTerminal[], edges: Map<NonTerminal, Set<NonTerminal>>) {
	const index = new Map<NonTerminal, number>();
	const low	= new Map<NonTerminal, number>();
	const stack: NonTerminal[] = [];
	const onStack = new Set<NonTerminal>();
	const components: NonTerminal[][] = [];
	let counter = 0;

	for (const root of nodes) {
		if (index.has(root))
			continue;
		const work: { node: NonTerminal; succ: NonTerminal[]; i: number }[] = [{ node: root, succ: [...(edges.get(root) ?? [])], i: 0 }];
		index.set(root, counter);
		low.set(root, counter++);
		stack.push(root);
		onStack.add(root);

		while (work.length) {
			const frame = work[work.length - 1];
			if (frame.i < frame.succ.length) {
				const next = frame.succ[frame.i++];
				if (!index.has(next)) {
					index.set(next, counter);
					low.set(next, counter++);
					stack.push(next);
					onStack.add(next);
					work.push({ node: next, succ: [...(edges.get(next) ?? [])], i: 0 });
				} else if (onStack.has(next)) {
					low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
				}
			} else {
				work.pop();
				if (work.length)
					low.set(work[work.length - 1].node, Math.min(low.get(work[work.length - 1].node)!, low.get(frame.node)!));
				if (low.get(frame.node) === index.get(frame.node)) {
					const comp: NonTerminal[] = [];
					for (let n = stack.pop()!; ; n = stack.pop()!) {
						onStack.delete(n);
						comp.push(n);
						if (n === frame.node)
							break;
					}
					components.push(comp);
				}
			}
		}
	}
	return components;
}

function ruleText(r: InternalRule) {
	return `${r.lhs.name} -> ${r.rhs.map(s => s.name).join(' ') || 'ε'}`;
}

// Nonterminals built from an inline `Rules(...)` in a rhs have no name of their own ('unknown name'),
// which makes a bare list of cycle members useless -- show one of each one's alternatives instead.
function describe(nt: NonTerminal, alts: Map<NonTerminal, InternalRule[]>) {
	const first = alts.get(nt)?.[0];
	return /^(unknown name|anon )/.test(nt.name) && first ? `'${first.rhs.map(s => s.name).join(' ') || 'ε'}'` : `'${nt.name}'`;
}

function analyse(g: GrammarBuilder): Analysis {
	const alts		= new Map<NonTerminal, InternalRule[]>();
	const anon		= new Map<NonTerminal, InternalRule>();
	const problems: string[] = [];

	// rules[0] is the augmented `$accept -> start $end` rule, which exists only to give the LR automaton
	// somewhere to accept; the PEG driver checks for EOF itself.
	for (const r of g.rules.slice(1)) {
		if (!r.rhs.length && r.peek !== undefined)
			anon.set(r.lhs, r);
		const list = alts.get(r.lhs);
		if (list)
			list.push(r);
		else
			alts.set(r.lhs, [r]);
	}

	// A bare epsilon alternative always succeeds, so under ordered choice every alternative after it is
	// dead code -- no grammar means that, and `Maybe()` (written epsilon-first for the LR back end) hits it
	// every time. Normalize it to last rather than silently parsing nothing.
	for (const [nt, list] of alts) {
		const empty = list.filter(r => !r.rhs.length && r.peek === undefined);
		if (empty.length && list[list.length - 1].rhs.length)
			alts.set(nt, [...list.filter(r => r.rhs.length || r.peek !== undefined), ...empty]);
	}

	const isNullable		= nullableSyms(g);
	const { edges, indirect }	= leftCorners(g, isNullable);

	for (const comp of stronglyConnected([...alts.keys()], edges)) {
		if (comp.length > 1) {
			problems.push(`error: indirect left recursion between ${comp.map(n => describe(n, alts)).join(' and ')}: PEG only supports the direct 'A -> A ...' form -- rewrite the cycle so one of them consumes input first`);
		} else if (indirect.has(comp[0])) {
			const r = indirect.get(comp[0])!;
			problems.push(`error: left recursion past a nullable prefix in '${ruleText(r)}': PEG only supports the direct 'A -> A ...' form, where the recursive symbol is first`);
		}
	}

	// Ordered choice commits to the first alternative that matches, so an alternative that is a prefix of a
	// later one hides it completely -- the later one can never be reached, however much more of the input it
	// would have matched. Order is irrelevant to the LR back end, so a grammar written for it hits this
	// routinely (`declarator -> IDENT` before `declarator -> IDENT '=' expr`, and `var x = 1` stops at `x`).
	const seen = new Set<string>();
	for (const [, list] of alts) {
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				if (!list[i].rhs.every((sym, k) => sym === list[j].rhs[k]))
					continue;
				const message = list[i].rhs.length === list[j].rhs.length
					? `warning: duplicate alternative '${ruleText(list[j])}': an identical earlier alternative always matches first, so this one is unreachable`
					: `warning: '${ruleText(list[i])}' shadows the later '${ruleText(list[j])}': under ordered choice the first match wins, so put the longer alternative first`;
				if (!seen.has(message)) {
					seen.add(message);
					problems.push(message);
				}
			}
		}
	}

	const direct	= new Map<NonTerminal, InternalRule[]>();
	const base		= new Map<NonTerminal, InternalRule[]>();
	for (const [nt, list] of alts) {
		direct.set(nt, list.filter(r => r.rhs[0] === nt));
		base.set(nt, list.filter(r => r.rhs[0] !== nt));
	}
	return { alts, direct, base, anon, problems };
}

// Everything wrong with `spec` read as a PEG, without building a parser -- for checking whether a grammar
// written for the LR back end will behave here. Each entry is prefixed 'error: ' (what `makePegParser`
// throws on: left recursion it can't express) or 'warning: ' (an alternative shadowed by ordered choice,
// which still builds but will silently never match). Empty means the grammar carries over as-is.
export function pegDiagnostics(spec: GrammarSpec<any>): string[] {
	return analyse(new GrammarBuilder(spec)).problems;
}

// ===================================================================
//  Parser
// ===================================================================

export function makePegParser<T, C = any>(spec: GrammarSpec<T>, options: PegOptions = {}): PegParser<T, C> {
	const g			= new GrammarBuilder(spec);
	const analysis	= analyse(g);
	const errors	= analysis.problems.filter(p => p.startsWith('error:'));
	if (errors.length)
		throw new Error(`Grammar is not a valid PEG:\n  ${errors.join('\n  ')}`);

	const { alts, direct, base, anon } = analysis;
	const maxMunch	= (options.lex ?? 'maxmunch') === 'maxmunch';
	const useMemo	= options.memo !== false;
	const maxDepth	= options.maxDepth ?? 2000;

	const ntId = new Map<NonTerminal, number>([...alts.keys()].map((nt, i) => [nt, i]));

	const resolveSym = (sym: Token<any> | Terminal | string | RegExp | undefined): Token<any> | Terminal | undefined =>
		typeof sym === 'string'	? g.terminalsByName.get(sym)
		: sym instanceof RegExp	? g.terminalsByName.get(sym.source)
		: sym;

	// Candidate sets handed to the shared lexer. `skipOnly` is also what checks for end-of-input: with
	// every candidate marked 'ignore', `nextToken` consumes trailing whitespace and then reports EOF.
	const skipOnly	= new Map<Terminal, ActionEntry>(g.alwaysSkip.map(t => [t, { kind: 'ignore' }]));
	const allTerms	= new Map<Terminal, ActionEntry>(skipOnly);
	for (const t of g.terminalsByName.values()) {
		if (!allTerms.has(t))
			allTerms.set(t, { kind: 'shift', state: 0 });
	}
	const directMaps = new Map<Terminal, Map<Terminal, ActionEntry>>();
	const mapFor = (t: Terminal) => {
		let m = directMaps.get(t);
		if (!m)
			directMaps.set(t, m = new Map<Terminal, ActionEntry>([...skipOnly, [t, { kind: 'shift', state: 0 }]]));
		return m;
	};

	return {
		grammar: g,
		parse: (input, ctx) => run(input, ctx, false).value as T,
		parsePrefix: (input, ctx) => {
			const m = run(input, ctx, true);
			return { value: m.value as T, consumed: m.pos.offset };
		},
	};

	function run(input: string, ctx: any, prefix: boolean): Match {
		// Two derivations reaching the same offset can still lex differently from there if a `Terminal.lex`
		// callback reads `lex.prev`, so the preceding token is part of every memo key, not just the offset.
		const prevKey	= (p: Pos) => p.prev ? `${p.prev.type.name}@${p.prev.pos.offset}` : '';
		const tokens	= new Map<string, { tok: Token; after: Pos }>();
		const memo		= new Map<string, Match | null>();
		const active	= new Set<string>();
		let failOffset	= -1;
		let failPos: TextPos = { offset: 0, line: 1, col: 1 };
		let expected	= new Set<string>();
		let depth		= 0;

		// Only the *furthest* failure is worth reporting: everything nearer was a choice being explored and
		// rejected, which is PEG working normally, not the input being wrong.
		const recordFail = (at: TextPos, name: string) => {
			if (at.offset > failOffset) {
				failOffset	= at.offset;
				failPos		= at;
				expected	= new Set();
			}
			if (at.offset === failOffset)
				expected.add(name);
		};

		const lex = (allowed: Map<Terminal, ActionEntry>, pos: Pos, key: string) => {
			let hit = tokens.get(key);
			if (!hit) {
				const state	= { offset: pos.offset, line: pos.line, col: pos.col, prev: pos.prev };
				const tok	= nextToken(allowed, input, state, ctx, resolveSym);
				hit = {
					tok,
					after: { ...getTextPos(state), prev: tok.type === EOF || tok.type === ERROR ? pos.prev : tok },
				};
				tokens.set(key, hit);
			}
			return hit;
		};

		function matchTerminal(t: Terminal, pos: Pos): Match | null {
			const { tok, after } = maxMunch
				? lex(allTerms, pos, `*${pos.offset}|${prevKey(pos)}`)
				: lex(mapFor(t), pos, `${t.name}|${pos.offset}|${prevKey(pos)}`);

			// `tok.pos` is past any skipped whitespace, so it's both the real start of a match and the right
			// place to blame for a failure.
			if (tok.type === t)
				return { value: tok.value, pos: after, start: tok.pos };

			recordFail(tok.pos, t.name);
			return null;
		}

		// `values` is the enclosing sequence's values so far, which a mid-rule action nonterminal needs to
		// look back into (`peek`); every other symbol ignores it.
		function matchSym(sym: InternalSym, pos: Pos, values: unknown[], minPrec: number): Match | null {
			if (sym instanceof Terminal)
				return matchTerminal(sym, pos);

			if (sym instanceof InternalPredicate) {
				if (!sym.negate) {
					const m = matchSym(sym.sym, pos, values, 0);
					return m && { value: m.value, pos, start: m.start };
				}
				// A negated predicate *succeeds* when its operand fails, so its operand's failures aren't the
				// parse going wrong and must not become the reported "expected" set. When it does block, the
				// predicate itself is what to report there instead.
				const saveOffset = failOffset, savePos = failPos, saveExpected = expected;
				const m = matchSym(sym.sym, pos, values, 0);
				failOffset	= saveOffset;
				failPos		= savePos;
				expected	= saveExpected;
				if (!m)
					return { value: undefined, pos, start: getTextPos(pos) };
				recordFail(m.start, sym.name);
				return null;
			}

			const mid = anon.get(sym);
			if (mid) {
				const peek = mid.peek ?? 0;
				return { value: mid.action(Object.assign(values.slice(values.length - peek), { pos: getTextPos(pos) }), ctx), pos, start: getTextPos(pos) };
			}
			return matchNonTerminal(sym, pos, minPrec);
		}

		// `values`/`from` let the seed-growing loop below re-enter an alternative with its leading
		// self-reference already bound, instead of re-parsing it (which is what would recurse forever).
		function matchAlt(r: InternalRule, pos: Pos, values: unknown[], from: number, start: TextPos | undefined): Match | null {
			const tailMin	= trailingMinPrec(r);
			const last		= r.rhs.length - 1;
			let cur			= pos;

			for (let i = from; i <= last; i++) {
				const sym = r.rhs[i];
				const m = matchSym(sym, cur, values, i === last && tailMin !== undefined && sym === r.lhs ? tailMin : 0);
				if (!m)
					return null;
				// The rule's own start is the first symbol that actually consumed something; a leading
				// predicate or nullable nonterminal would otherwise pin it to before the skipped whitespace.
				if (start === undefined && m.pos.offset > cur.offset)
					start = m.start;
				values.push(m.value);
				cur = m.pos;
			}
			start ??= getTextPos(pos);
			return { value: r.action(Object.assign(values, { pos: start }), ctx), pos: cur, start };
		}

		function matchNonTerminal(nt: NonTerminal, pos: Pos, minPrec: number): Match | null {
			const key = `${ntId.get(nt)}|${minPrec}|${pos.offset}|${prevKey(pos)}`;
			if (useMemo && memo.has(key))
				return memo.get(key)!;

			// Only reachable through a left-recursive path `analyse` failed to reject; without this it would
			// be a silent stack overflow far from the actual cause.
			if (active.has(key))
				throw new Error(`Unsupported left recursion re-entering '${nt.name}' at offset ${pos.offset}`);
			if (++depth > maxDepth) {
				depth = 0;
				throw new Error(`PEG recursion depth exceeded ${maxDepth} at line ${pos.line}, col ${pos.col} (raise PegOptions.maxDepth, or look for a rule that recurses without consuming input)`);
			}
			active.add(key);
			try {
				const result = matchAlts(nt, pos, minPrec);
				if (useMemo)
					memo.set(key, result);
				return result;
			} finally {
				active.delete(key);
				--depth;
			}
		}

		function matchAlts(nt: NonTerminal, pos: Pos, minPrec: number): Match | null {
			const lr = direct.get(nt)!;

			// Ordinary ordered choice: first alternative that matches wins, outright.
			if (!lr.length) {
				for (const r of alts.get(nt)!) {
					if (levelOf(r) < minPrec)
						continue;
					const m = matchAlt(r, pos, [], 0, undefined);
					if (m)
						return m;
				}
				return null;
			}

			// Left recursion, as precedence climbing: match a non-recursive alternative for the seed, then
			// repeatedly re-offer it as the leading symbol of a recursive alternative for as long as one
			// extends it. `minPrec` gates which operators may apply, so `3 * 4 + 5` groups as `(3 * 4) + 5`
			// even though both alternatives are equally applicable to the bare seed `3`.
			let seed: Match | null = null;
			for (const r of base.get(nt)!) {
				if (levelOf(r) < minPrec)
					continue;
				if ((seed = matchAlt(r, pos, [], 0, undefined)))
					break;
			}
			if (!seed)
				return null;

			for (let floor = minPrec, growing = true; growing;) {
				growing = false;
				for (const r of lr) {
					const level = levelOf(r);
					if (level < floor)
						continue;
					const m = matchAlt(r, seed.pos, [seed.value], 1, seed.start);
					// A recursive alternative that matched without consuming anything (all-nullable tail)
					// would otherwise grow the seed forever without ever moving.
					if (m && m.pos.offset > seed.pos.offset) {
						seed	= m;
						growing	= true;
						if (r.prec?.assoc === 'nonassoc')
							floor = Math.max(floor, level + 1);
						break;
					}
				}
			}
			return seed;
		}

		const startPos: Pos = { offset: 0, line: 1, col: 1 };
		const m = matchNonTerminal(g.startSymbol, startPos, 0);

		if (m && !prefix) {
			const { tok } = lex(skipOnly, m.pos, `$${m.pos.offset}|${prevKey(m.pos)}`);
			if (tok.type !== EOF) {
				recordFail(tok.pos, 'end of input');
				return fail();
			}
		}
		return m ?? fail();

		function fail(): never {
			const names = [...expected];
			throw new SyntaxError(
				`Unexpected ${failPos.offset >= input.length ? 'end of input' : `character '${input[failPos.offset]}'`}`
				+ ` at line ${failPos.line}, col ${failPos.col}. `
				+ `Expected: ${names.length ? names.join(', ') : '(nothing)'}`
			);
		}
	}
}
