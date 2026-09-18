// ===================================================================
//  Inline assembly
// ===================================================================
// The inline-`__asm` island: from the island's WAT body and the signature its call settled on, to the
// instructions a wasm function carries. Everything here manipulates WAT instructions and `wasm-codegen`
// representations -- the language's own types never appear, and `AsmDecl` is the concrete, already-lowered
// signature it hands over (the plan's idiom: a base interface the language fills in, never a type parameter
// over its type -- a seam that needs one is a seam in the wrong place).
//
// What is per-language is therefore only the island's SPELLING (recognising `__asm`, reading the WAT text
// and the declared types off it) and the type answers the language alone has: what a declared type lowers
// to, and what a `TYPEINDEX` operand names. Those are that language's ordinary type-model operations, not
// something the island adds; the one thing that is genuinely shared beyond this file is
// `WT.elementValueType` (the packed-kind rule), which lives with the rest of the wasm vocabulary.

import * as wasm from '@isopodlabs/binary_libs/wasm';
import * as WAT from './wat-parser';
import * as WT from './wasm-codegen';

const I = wasm.I;

// The four numeric wasm types, in "widen to me first" preference order when an operand's own type has no
// real instruction -- f64 first, since widening i32/i64/f32 up to it is exact or an already-accepted tradeoff.
const NUMERIC_TYPES = ['f64', 'f32', 'i64', 'i32'] as const;
type NumericType = typeof NUMERIC_TYPES[number];
function isNumericType(t: WT.Type | undefined): t is NumericType { return NUMERIC_TYPES.includes(t as NumericType); }

// The physical result of an asm body: a signature and its instructions. `Inline` in the language half is
// this plus the argument-binding payload an asm body never reads, so this is its projection, not a copy.
interface AsmInline extends WT.ClosureSig { inline: wasm.Instr[] }

// The one piece of codegen state an asm body touches: named scratch locals.
interface AsmCtx { temp(name: string, wtype: WT.Type): number }

// The signature ONE asm call settled on -- concrete representations only, so the language's own types stay
// on its side -- plus the `TYPEINDEX` resolver that belongs to it. The two travel together because a
// `TYPEINDEX` operand must agree with the very signature its own call settled on (an `array.copy`'s operand
// types are read against it), which is a fact about the types involved and so only the language can answer.
export interface AsmDecl extends WT.ClosureSig {
	typeIndex(text: string): number | undefined;
}

// What the language knows about an island before any call site exists.
export interface AsmSource {
	asm: string;
	defines?: Record<string, string | number>;
	// Whether the declared signature depends on the call site's type arguments: a generic owner, or a body
	// naming `TYPEINDEX`. Decided by the language, since only it has type parameters.
	generic: boolean;
	// The declared arity. A `$T`-switched body's runtime signature is the chosen numeric type, but its
	// arity still comes from the declaration.
	paramCount: number;
}

// An island, prepared once. A `$T`-switched body needs no signature at all -- the chosen numeric type IS
// its signature -- so the two shapes are distinguished here rather than by an optional argument the caller
// could get wrong.
type PreparedAsm =
	| { switched: true;		render(args: (WT.Type | undefined)[], ctx: AsmCtx): AsmInline }
	| { switched: false;	render(args: (WT.Type | undefined)[], ctx: AsmCtx, decl: AsmDecl): AsmInline };

// One numeric type's expansion of a `$T`-switch body.
type TypeSwitchVariants = Partial<Record<NumericType, { locals: WAT.WatLocal[]; body: wasm.Instr[] }>>;

function assertFlatInstrs(instrs: WAT.WatInstr[], asm: string): wasm.Instr[] {
	return instrs.map(i => {
		//if (i.op === 'block' || i.op === 'loop' || i.op === 'if' || i.op === 'try_table')
		//	throw `inline asm '${asm}': '${i.op}' (control flow) is not supported in inline asm`;
		if (i.op === '__switch')
			throw `inline asm '${asm}': switch '${i.key}' is unresolved -- not a ctx.defines entry, and inline asm has no enclosing macro call to bind it to a $tag argument`;
		if (i.op === '__local')
			throw `inline asm '${asm}': local '${i.id}' should already have been hoisted into a separate locals list`;
		// A `$T.<suffix>` reference with no enclosing `(switch $T ...)` declaring its supported types is a
		// real authoring error, not a type this body happens to support.
		if (i.op === 'local.get' && typeof i.localIndex === 'string' && i.localIndex.startsWith('$T.'))
			throw `inline asm '${asm}': '${i.localIndex}' needs an enclosing '(switch $T ...)' declaring which types it's for`;
		return i;
	});
}

// A `$T`-keyed switch, expanded once per numeric type its arms declare. An arm's own body can declare
// further `$T`-typed locals (embedded as `__local` markers in its own body, same as everywhere else --
// switch_arm never splits them out) and further `$T.suffix` references, so a winning arm is processed by
// recursing back into this same walk, exactly as if the arm's own body were the whole generic body.
function expandTypeSwitch(parsed: { locals: WAT.WatLocal[]; body: WAT.WatInstr[] }, sw: WAT.SwitchPlaceholder, asm: string): TypeSwitchVariants {
	const variants: TypeSwitchVariants = {};

	for (const type of new Set(sw.arms.flatMap(a => a.values).filter(a => typeof a === 'string').map(a => a.slice(1) as NumericType))) {
		const locals:	WAT.WatLocal[] = [];
		const body:		WAT.WatInstr[] = [];

		const addLocals = (ls: WAT.WatLocal[]) => locals.push(...ls.map(l => ({
			id:		l.id,
			count:	l.count,
			type:	typeof l.type === 'object' && 'typeParam' in l.type ? type : l.type,
		})));

		function process(items: WAT.WatInstr[]): boolean {
			for (const i of items) {
				if (i.op === '__local') {
					addLocals([i]);
				} else if (i.op === 'local.get' && typeof i.localIndex === 'string' && i.localIndex.startsWith('$T.')) {
					const oper = i.localIndex.slice(3);
					if (!(oper in I[type]))
						return false;
					body.push((I[type] as any)[oper]);
				} else if (i.op === '__switch' && i.key === '$T') {
					const arm = i.arms.find(a => a.values.includes(`$${type}`));
					if (!arm)
						return false;
					if (!process(arm.body))
						return false;
				} else {
					body.push(i);
				}
			}
			return true;
		}

		addLocals(parsed.locals);
		if (!process(parsed.body))
			throw `inline asm '${asm}': switch arm '(${sw.arms.find(a => a.values.includes(`$${type}`))!.values.join(' ')})' claims '${type}' but its own body doesn't resolve for it`;
		variants[type] = { locals, body: assertFlatInstrs(body, asm) };
	}
	if (!Object.keys(variants).length)
		throw `inline asm '${asm}': switch '$T' has no arms`;

	return variants;
}

// Resolves named scratch locals to real local indices via ctx.local
function resolveAsmLocals(instrs: wasm.Instr[], locals: WAT.WatLocal[], ctx: AsmCtx, asm: string): wasm.Instr[] {
	const indices = new Map(locals.map(l => {
		if (!l.id)
			throw `inline asm '${asm}': an anonymous local can't be referenced by name`;
		if (l.type === 'i32' || l.type === 'i64' || l.type === 'f32' || l.type === 'f64')
			return [l.id, ctx.temp(l.id, l.type)];
		throw `inline asm '${asm}': unsupported local type '${typeof l.type === 'string' ? l.type : 'ref'}'`;
	}));
	return instrs.map(i => {
		if ('localIndex' in i && typeof i.localIndex === 'string') {
			const index = indices.get(i.localIndex);
			if (index === undefined)
				throw `inline asm '${asm}': undeclared local '${i.localIndex}'`;
			return { ...i, localIndex: index };
		}
		return i;
	});
}

// A `TYPEINDEX("T[]")` operand, resolved AFTER parsing -- the assembler carried the text through opaquely
// (it knows nothing of source-language types, and `toWasm`'s own note keeps it that way), exactly as it
// leaves a `$name` for a later pass. The sibling of `resolveAsmLocals`, one operand slot over; the TEXT is
// handed to the language, which alone can say what it names.
// Every field a type index can land in -- `array.copy` carries two (`dst`/`src`), not `typeIndex`, and
// missing them left the sentinel string in place to fail much later as a NaN.
// Narrowed with `in` before each spread, as `resolveAsmLocals` does: spreading the whole `Instr` union
// without it is "a union type that is too complex to represent".
function resolveTypeExprs(instrs: wasm.Instr[], resolveIndex: (text: string) => number | undefined): wasm.Instr[] {
	const resolve = (v: unknown): number | undefined =>
		typeof v === 'string' && v.startsWith(WAT.TYPE_EXPR) ? resolveIndex(v.slice(WAT.TYPE_EXPR.length)) : undefined;
	return instrs.map(i => {
		if ('typeIndex' in i) {
			const r = resolve(i.typeIndex);
			if (r !== undefined)
				return { ...i, typeIndex: r };
		}
		if ('dst' in i && 'src' in i) {
			const d = resolve(i.dst), sr = resolve(i.src);
			if (d !== undefined || sr !== undefined)
				return { ...i, dst: d ?? i.dst, src: sr ?? i.src };
		}
		return i;
	});
}

// The three shapes an asm body takes. A generic body's signature and type operands depend on the call
// site's type arguments, so its operands are resolved per call; a `$T` body's signature is the numeric type
// its arguments agree on; anything else is resolved once.
export function makeAsm(src: AsmSource): PreparedAsm {
	const { asm } = src;
	const parsed = WAT.parseAsmBody(asm, src.defines);

	if (src.generic) {
		const flat = assertFlatInstrs(parsed.body, asm);
		const locals = parsed.locals.map(l => ({ id: l.id, count: l.count, type: l.type as wasm.ValType }));
		return {
			switched: false,
			render: (_args, ctx, decl) => ({
				params: decl.params, result: decl.result,
				inline: resolveAsmLocals(resolveTypeExprs(flat, decl.typeIndex), locals, ctx, asm)
			})
		};
	}

	const sw = parsed.body.find((i): i is WAT.SwitchPlaceholder => i.op === '__switch' && i.key === '$T');
	if (sw) {
		const variants = expandTypeSwitch(parsed, sw, asm);
		const { paramCount } = src;
		return {
			switched: true,
			render: (args, ctx) => {
				let t = args[0];
				if (!isNumericType(t) || !variants[t] || args.length !== paramCount || !args.every(a => a === t)) {
					t = NUMERIC_TYPES.find(nt => variants[nt]);
					if (!t)
						throw 'no numeric type supports this operation';
				}
				const chosen = variants[t]!;
				return { params: Array.from({ length: paramCount }, () => t), result: t, inline: resolveAsmLocals(chosen.body, chosen.locals, ctx, asm) };
			}
		};
	}

	const body = {
		locals: parsed.locals.map(l => {
			if (typeof l.type === 'object' && 'typeParam' in l.type)
				throw `inline asm '${asm}': '(local ${l.id ?? ''} $${l.type.typeParam})' needs a '$T'-generic asm`;
			return { id: l.id, count: l.count, type: l.type };
		}),
		body: assertFlatInstrs(parsed.body, asm)
	};
	return {
		switched: false,
		render: (_args, ctx, decl) => ({ params: decl.params, result: decl.result, inline: resolveAsmLocals(body.body, body.locals, ctx, asm) })
	};
}
