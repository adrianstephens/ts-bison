// ===================================================================
//  C/C++ Preprocessor -- translation phases 2-4 (line splicing, comment
//  removal, directives, macro expansion) as a text->text pass for the
//  C/C++ parsers. Physical line numbers are preserved (blank lines are
//  emitted for directives and skipped regions) except across #include.
// ===================================================================

export interface PreprocessOptions {
	// -D equivalents; keys may be function-like ('MIN(a,b)'), values are replacement text
	defines?:	Record<string, string>;
	// return source text for an #include, or undefined to skip it silently (the default)
	include?:	(name: string, angled: boolean) => Promise<string | undefined>;
	filename?:	string;
}

interface Tok {
	text:	string;
	ws:		boolean;			// preceded by whitespace (for stringize and re-emission)
	line:	number;
	hide?:	Set<string>;		// macros already expanded to produce this token (recursion guard)
}

interface Macro {
	params?:	string[];		// undefined = object-like
	variadic?:	boolean;
	body:		Tok[];
}

const TOKEN_RE	= /[ \t\v\f]+|[A-Za-z_]\w*|(?:\d|\.\d)(?:[eEpP][+-]|'\d|\w|\.)*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<<=|>>=|\.\.\.|->\*|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||##|::|[-+*/%&|^!=<>]=|./g;
const isIdent	= (s: string) => /^[A-Za-z_]\w*$/.test(s);

function tokenize(src: string, line: number): Tok[] {
	const out: Tok[] = [];
	let ws = false;
	for (const m of src.matchAll(TOKEN_RE)) {
		if (/^[ \t\v\f]/.test(m[0])) {
			ws = true;
		} else {
			out.push({text: m[0], ws, line});
			ws = false;
		}
	}
	return out;
}

// Comments become a space; newlines inside block comments are kept so line numbers survive.
function stripComments(src: string): string {
	let out = '';
	for (let i = 0; i < src.length; ) {
		const c = src[i];
		if (c === '"' || c === "'") {
			out += src[i++];
			while (i < src.length && src[i] !== c && src[i] !== '\n') {
				out += src[i++];
				if (src[i - 1] === '\\' && i < src.length)
					out += src[i++];
			}
			if (i < src.length && src[i] === c)
				out += src[i++];
		} else if (c === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n')
				++i;
		} else if (c === '/' && src[i + 1] === '*') {
			let nl = '';
			for (i += 2; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); ++i) {
				if (src[i] === '\n')
					nl += '\n';
			}
			i = Math.min(i + 2, src.length);
			out += ' ' + nl;
		} else {
			out += src[i++];
		}
	}
	return out;
}

function stringize(toks: Tok[]): string {
	return '"' + toks.map((t, i) => {
		const text = /^["']/.test(t.text) ? t.text.replace(/[\\"]/g, c => '\\' + c) : t.text;
		return i && t.ws ? ' ' + text : text;
	}).join('') + '"';
}

// re-emission: honour the ws flag, plus a space wherever omitting one could fuse two tokens into a new one
function append(line: string, t: Tok): string {
	if (!line)
		return t.text;
	const sep = t.ws
		|| (/\w$/.test(line) && /^\w/.test(t.text))
		|| (/[-+<>&|=*/%^!~#]$/.test(line) && /^[-+<>&|=*/%^!~#=]/.test(t.text));
	return line + (sep ? ' ' : '') + t.text;
}

function intValue(t: string): number {
	const s = t.replace(/'/g, '').replace(/[uUlL]+$/, '');
	return /^0[xX]/.test(s)	? parseInt(s, 16)
		: /^0[bB]/.test(s)	? parseInt(s.slice(2), 2)
		: /^0./.test(s)		? parseInt(s, 8)
		: parseInt(s, 10);
}

function charValue(t: string): number {
	const s = t.slice(1, -1);
	if (s[0] !== '\\')
		return s.charCodeAt(0);
	if (s[1] === 'x')
		return parseInt(s.slice(2), 16);
	if (/\d/.test(s[1]))
		return parseInt(s.slice(1), 8);
	return ({n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11} as Record<string, number>)[s[1]] ?? s.charCodeAt(1);
}

// integer constant expression for #if/#elif ('defined' has already been replaced, unknown identifiers are 0)
function evalExpr(toks: Tok[], where: string): number {
	let i = 0;
	const fail = (msg: string): never => { throw new Error(`${where}: ${msg} in #if expression`); };
	const expect = (s: string) => toks[i]?.text === s ? ++i : fail(`expected '${s}'`);

	const primary = (): number => {
		const t = toks[i++]?.text;
		if (t === undefined)
			return fail('unexpected end');
		switch (t) {
			case '(': { const v = ternary(); expect(')'); return v; }
			case '!': return primary() ? 0 : 1;
			case '~': return ~primary();
			case '-': return -primary();
			case '+': return primary();
		}
		return t === 'true'		? 1
			: isIdent(t)		? 0
			: t[0] === "'"		? charValue(t)
			: /^\.?\d/.test(t)	? intValue(t)
			: fail(`unexpected '${t}'`);
	};

	const BINPREC: Record<string, number> = {'||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10};
	const binary = (min: number): number => {
		let a = primary();
		for (let op = toks[i]?.text, p; op !== undefined && (p = BINPREC[op]) && p >= min; op = toks[i]?.text) {
			++i;
			const b = binary(p + 1);
			switch (op) {
				case '||':	a = a || b ? 1 : 0; break;
				case '&&':	a = a && b ? 1 : 0; break;
				case '|':	a |= b; break;
				case '^':	a ^= b; break;
				case '&':	a &= b; break;
				case '==':	a = a === b ? 1 : 0; break;
				case '!=':	a = a !== b ? 1 : 0; break;
				case '<':	a = a < b ? 1 : 0; break;
				case '>':	a = a > b ? 1 : 0; break;
				case '<=':	a = a <= b ? 1 : 0; break;
				case '>=':	a = a >= b ? 1 : 0; break;
				case '<<':	a <<= b; break;
				case '>>':	a >>= b; break;
				case '+':	a += b; break;
				case '-':	a -= b; break;
				case '*':	a *= b; break;
				// 0 (not a throw) so the unevaluated side of a short-circuit can't blow up
				case '/':	a = b ? Math.trunc(a / b) : 0; break;
				case '%':	a = b ? a % b : 0; break;
			}
		}
		return a;
	};

	const ternary = (): number => {
		const c = binary(1);
		if (toks[i]?.text !== '?')
			return c;
		++i;
		const a = ternary();
		expect(':');
		const b = ternary();
		return c ? a : b;
	};

	const v = ternary();
	if (i < toks.length)
		fail(`unexpected '${toks[i].text}'`);
	return v;
}

export class Preprocessor {
	private macros	= new Map<string, Macro>();
	private cond:	{active: boolean, taken: boolean}[] = [];
	private active	= true;
	private out:	string[] = [];
	private file	= '';
	private depth	= 0;

	constructor(private options: PreprocessOptions = {}) {
		for (const [k, v] of Object.entries(options.defines ?? {}))
			this.define(v === '' ? k : `${k} ${v}`, 0);
	}

	get result() {
		return this.out.join('\n');
	}

	private error(line: number, msg: string): never {
		throw new Error(`${this.file}:${line}: ${msg}`);
	}

	private define(text: string, line: number) {
		const m = /^([A-Za-z_]\w*)/.exec(text.trim());
		if (!m)
			this.error(line, 'bad #define');
		const name = m[1];
		let rest = text.trim().slice(name.length);
		let params: string[] | undefined, variadic = false;
		if (rest[0] === '(') {
			const close = rest.indexOf(')');
			if (close < 0)
				this.error(line, `bad parameter list for macro '${name}'`);
			params = [];
			const inner = rest.slice(1, close).trim();
			if (inner) {
				for (const p of inner.split(',').map(s => s.trim())) {
					if (p === '...')
						variadic = true;
					else if (isIdent(p))
						params.push(p);
					else
						this.error(line, `bad macro parameter '${p}'`);
				}
			}
			rest = rest.slice(close + 1);
		}
		this.macros.set(name, {params, variadic, body: tokenize(rest, line)});
	}

	private expand(input: Tok[]): Tok[] {
		const toks = input.slice();
		const out: Tok[] = [];
		let i = 0;
		while (i < toks.length) {
			const t = toks[i];
			if (!isIdent(t.text) || t.hide?.has(t.text)) {
				out.push(t);
				++i;
				continue;
			}
			if (t.text === '__LINE__') {
				out.push({...t, text: String(t.line)});
				++i;
				continue;
			}
			if (t.text === '__FILE__') {
				out.push({...t, text: JSON.stringify(this.file)});
				++i;
				continue;
			}
			const m = this.macros.get(t.text);
			if (!m) {
				out.push(t);
				++i;
				continue;
			}
			const hide = new Set(t.hide).add(t.text);
			if (!m.params) {
				toks.splice(i, 1, ...m.body.map((b, j) => ({text: b.text, ws: j ? b.ws : t.ws, line: t.line, hide})));
				continue;	// rescan from i
			}
			// function-like: without an immediate '(' (or with none closing in this block) it's a plain identifier
			if (toks[i + 1]?.text !== '(') {
				out.push(t);
				++i;
				continue;
			}
			const nargs = m.params.length + (m.variadic ? 1 : 0);
			const args: Tok[][] = [[]];
			let j = i + 2, depth = 0;
			for (; j < toks.length; ++j) {
				const a = toks[j];
				if (a.text === '(') {
					++depth;
				} else if (a.text === ')') {
					if (!depth)
						break;
					--depth;
				}
				// in a variadic call, commas beyond the named parameters stay inside __VA_ARGS__
				if (a.text === ',' && !depth && (!m.variadic || args.length < nargs))
					args.push([]);
				else
					args[args.length - 1].push(a);
			}
			if (j >= toks.length) {
				out.push(t);
				++i;
				continue;
			}
			if (args.length === 1 && !args[0].length && !nargs)
				args.pop();
			if (m.variadic ? args.length < m.params.length : args.length !== m.params.length)
				this.error(t.line, `macro '${t.text}' expects ${m.params.length}${m.variadic ? '+' : ''} argument(s), got ${args.length}`);
			while (args.length < nargs)
				args.push([]);
			toks.splice(i, j - i + 1, ...this.subst(m, args, hide, t));
		}
		return out;
	}

	private subst(m: Macro, args: Tok[][], hide: Set<string>, from: Tok): Tok[] {
		const params	= m.variadic ? [...m.params!, '__VA_ARGS__'] : m.params!;
		const argOf		= (name: string) => { const idx = params.indexOf(name); return idx < 0 ? undefined : args[idx]; };
		const cache:	Record<string, Tok[]> = {};
		const expanded	= (name: string) => cache[name] ??= this.expand(argOf(name)!);
		const rehide	= (a: Tok): Tok => ({...a, hide: a.hide ? new Set([...a.hide, ...hide]) : hide});

		const out: Tok[] = [];
		const body = m.body;
		for (let i = 0; i < body.length; ++i) {
			const b = body[i];
			if (b.text === '#' && body[i + 1] && argOf(body[i + 1].text)) {
				out.push({text: stringize(argOf(body[++i].text)!), ws: b.ws, line: from.line, hide});
				continue;
			}
			if (body[i + 1]?.text === '##') {
				// paste chain: operands are raw (unexpanded) arguments
				let acc = argOf(b.text)?.map(rehide) ?? [{text: b.text, ws: b.ws, line: from.line, hide}];
				if (acc.length)
					acc[0] = {...acc[0], ws: b.ws};
				while (body[i + 1]?.text === '##' && i + 2 < body.length) {
					const rb	= body[i += 2];
					const right	= argOf(rb.text)?.map(rehide) ?? [{text: rb.text, ws: rb.ws, line: from.line, hide}];
					if (!right.length) {
						// GNU comma deletion: ', ## __VA_ARGS__' with no variadic arguments drops the comma
						if (rb.text === '__VA_ARGS__' && acc[acc.length - 1]?.text === ',')
							acc.pop();
					} else if (!acc.length) {
						acc = right;
					} else {
						const l = acc.pop()!;
						acc.push({text: l.text + right[0].text, ws: l.ws, line: from.line, hide}, ...right.slice(1));
					}
				}
				out.push(...acc);
				continue;
			}
			const arg = argOf(b.text);
			if (arg) {
				const exp = expanded(b.text).map(rehide);
				if (exp.length)
					exp[0] = {...exp[0], ws: b.ws};
				out.push(...exp);
				continue;
			}
			out.push({text: b.text, ws: b.ws, line: from.line, hide});
		}
		if (out.length)
			out[0] = {...out[0], ws: from.ws};
		return out;
	}

	private evalIf(rest: string, line: number): number {
		const toks = tokenize(rest, line);
		const rep: Tok[] = [];
		for (let i = 0; i < toks.length; ++i) {
			const t = toks[i];
			if (t.text === 'defined') {
				let name = toks[i + 1];
				if (name?.text === '(') {
					name = toks[i + 2];
					i += toks[i + 3]?.text === ')' ? 3 : 2;
				} else {
					++i;
				}
				rep.push({text: name && this.macros.has(name.text) ? '1' : '0', ws: t.ws, line: t.line});
			} else {
				rep.push(t);
			}
		}
		return evalExpr(this.expand(rep), `${this.file}:${line}`);
	}

	private async include(rest: string, line: number) {
		const HDR = /^"([^"]*)"|^<([^>]*)>/;
		let m = HDR.exec(rest.trim());
		if (!m) {
			// computed include: macro-expand the operand and retry
			const text = this.expand(tokenize(rest, line)).map((t, i) => (i && t.ws ? ' ' : '') + t.text).join('');
			m = HDR.exec(text.trim());
		}
		if (!m)
			this.error(line, 'bad #include');
		const name = m[1] ?? m[2];
		const src = await this.options.include?.(name, m[2] !== undefined);
		if (src !== undefined) {
			if (++this.depth > 50)
				this.error(line, `include depth exceeded at '${name}'`);
			this.run(src, name);
			--this.depth;
		}
	}

	private setActive() {
		this.active = this.cond.every(c => c.active);
	}

	private directive(name: string, rest: string, line: number) {
		switch (name) {
			case 'if':
			case 'ifdef':
			case 'ifndef': {
				if (!this.active) {
					this.cond.push({active: false, taken: true});	// taken so #elif/#else can never activate
					break;
				}
				let v: boolean;
				if (name === 'if') {
					v = !!this.evalIf(rest, line);
				} else {
					const m = /^[A-Za-z_]\w*/.exec(rest) ?? this.error(line, `bad #${name}`);
					v = this.macros.has(m[0]) === (name === 'ifdef');
				}
				this.cond.push({active: v, taken: v});
				break;
			}
			case 'elif': {
				const c = this.cond[this.cond.length - 1] ?? this.error(line, '#elif without #if');
				if (c.taken)
					c.active = false;
				else
					c.active = c.taken = !!this.evalIf(rest, line);
				break;
			}
			case 'else': {
				const c = this.cond[this.cond.length - 1] ?? this.error(line, '#else without #if');
				c.active = !c.taken;
				c.taken = true;
				break;
			}
			case 'endif':
				if (!this.cond.pop())
					this.error(line, '#endif without #if');
				break;
			default:
				if (!this.active)
					break;
				switch (name) {
					case 'define':	this.define(rest, line); break;
					case 'undef': {
						const m = /^[A-Za-z_]\w*/.exec(rest);
						if (m)
							this.macros.delete(m[0]);
						break;
					}
					case 'include':	this.include(rest, line); break;
					case 'error':	this.error(line, `#error ${rest.trim()}`); break;
					default:		break;	// #pragma, #line, #warning, null and unknown directives are ignored
				}
				return;
		}
		this.setActive();
	}

	private emit(toks: Tok[], start: number, total: number) {
		const lines: string[] = [];
		let cur = 0;
		for (const t of toks) {
			// clamp monotonically: substituted argument tokens can point backwards, and order must win over position
			cur = Math.min(Math.max(cur, t.line - start), total - 1);
			lines[cur] = append(lines[cur] ?? '', t);
		}
		for (let i = 0; i < total; ++i)
			this.out.push(lines[i] ?? '');
	}

	run(src: string, file: string) {
		const saveFile	= this.file;
		const saveCond	= this.cond.length;
		this.file = file;

		const lines = stripComments(src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).split('\n');
		let block: Tok[] = [];
		let blockStart = 0, blockTotal = 0;
		const flush = () => {
			if (blockTotal) {
				this.emit(this.expand(block), blockStart, blockTotal);
				block = [];
				blockTotal = 0;
			}
		};

		for (let i = 0; i < lines.length; ++i) {
			const start = i + 1;
			let text = lines[i];
			while (text.endsWith('\\') && i + 1 < lines.length)
				text = text.slice(0, -1) + lines[++i];
			const phys = i + 2 - start;

			const d = /^[ \t]*#[ \t]*(\w*)[ \t]*([^]*)$/.exec(text);
			if (d) {
				flush();
				this.directive(d[1], d[2], start);
				for (let k = 0; k < phys; ++k)
					this.out.push('');
			} else if (this.active) {
				if (!blockTotal)
					blockStart = start;
				block.push(...tokenize(text, start));
				blockTotal += phys;
			} else {
				for (let k = 0; k < phys; ++k)
					this.out.push('');
			}
		}
		flush();

		if (this.cond.length !== saveCond)
			this.error(lines.length, 'unterminated #if');
		this.file = saveFile;
	}
}

export function preprocess(source: string, options: PreprocessOptions = {}): string {
	const pp = new Preprocessor(options);
	pp.run(source, options.filename ?? '<source>');
	return pp.result;
}
