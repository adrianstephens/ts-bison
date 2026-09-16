import * as C from './c-parser';
import * as CPP from './cpp-parser';
import { Module } from '../common';
import * as W from '../walker';
import { mapObject, mapArray, mapArrayA, mapDefined, makeProcess, makeProcessB } from '../walker';

type Definition			= CPP.Definition;
type Stmt				= CPP.Stmt;
type Expr				= CPP.Expr;
type ClassMember		= CPP.ClassMember;
type Declarator			= CPP.Declarator;
type AbstractDeclarator	= CPP.AbstractDeclarator;
type TypeName			= CPP.TypeName;
type TypeSpecifier		= CPP.TypeSpecifier;
type TypeSpecifierExt	= CPP.TypeSpecifierExt;
type DeclSpec			= CPP.DeclSpec;
type ParamDecl			= CPP.ParamDecl;
type InitDeclarator	=	 C.InitDeclarator<Declarator, Expr>;
type Block				= C.Block<Declarator, TypeSpecifierExt, Expr, Stmt>;
// The `declaration`/`typedef` tags, widened -- cpp's `Definition`/`Statement` unions inline these rather than
// exporting them under their own names, so name the widened instantiations locally.
type Declaration		= C.Declaration<Declarator, TypeSpecifierExt, Expr>;
type TypedefDecl		= C.TypedefDecl<Declarator, TypeSpecifierExt, Expr>;

//-----------------------------------------------------------------------------
//  Type Guards
//-----------------------------------------------------------------------------

export function guard<R>(types: string[]) {
	const set = new Set(types);
	return (node: any): node is R => node && typeof node === 'object' && 'type' in node && set.has(node.type);
}

const exprTags			= ['identifier', 'literal', 'char_literal', 'unary', 'unary_post', 'binary', 'assign', 'conditional', 'index', 'member', 'pointer_member', 'call', 'cast', 'sizeof_type', 'this', 'null_literal', 'qualified', 'new', 'delete', 'spread', 'sizeof_pack', 'cpp_cast', 'typeid', 'alignof', 'functional_cast', 'lambda'];
const declaratorTags	= ['identifier', 'pointer', 'array', 'function', 'reference', 'rvalue_reference'];
const packParamTags	= ['parameter']; // both ParameterDecl and PackParameter use this tag; distinguished by `pack`

export const isExpr				= guard<Expr>(exprTags);
export const isDeclarator		= guard<Declarator | AbstractDeclarator>(declaratorTags);
export const isPackParameter	= (p: ParamDecl): p is CPP.PackParameter => !!packParamTags.includes(p.type) && 'pack' in p && !!p.pack;

//-----------------------------------------------------------------------------
//  C++ constant folding
//-----------------------------------------------------------------------------

// C++ needs a TYPE to define arithmetic in: `unsigned` wraps, `/` truncates, `-1 < 1u` is false (the -1 becomes 4294967295 first), `1.0f + 1.5` is a double.
// This AST resolves no declarations, so the only type information anywhere in it is a literal's own SUFFIX -- which the parser now keeps as `Literal.raw`.
// That is what makes folding definable: only a literal's type is knowable, so only an expression whose every operand is a literal is folded.
// That is also exactly where folding is SAFE -- a literal cannot have a class type, so no overloaded operator can be involved, and no operand has an effect whose order folding would disturb.
//
// LP64 is assumed throughout (macOS/Linux: `int` 32, `long` 64). Windows' LLP64 makes `long` 32-bit, and no literal spelling distinguishes the two.
//
// Every integer operation is done in BigInt: js's own bitwise and shift operators coerce through
// int32, so `1 << 31` and `4294967295 & 1` would both be quietly wrong here, and 64-bit values need
// an exactness a double doesn't have. A result is only folded when it can be spelled EXACTLY -- a JS
// number is what gets printed, so `~0ull` (past 2^53) is refused rather than printed as a different
// constant than C++ computes.

const INT_KINDS = {
	bool:					{ bits: 32, unsigned: false,	suffix: ''		},
	int:					{ bits: 32, unsigned: false,	suffix: ''		},
	unsigned:				{ bits: 32, unsigned: true,		suffix: 'u'		},
	long:					{ bits: 64, unsigned: false,	suffix: 'L'		},
	'unsigned long':		{ bits: 64, unsigned: true,		suffix: 'UL'	},
	'long long':			{ bits: 64, unsigned: false,	suffix: 'LL'	},
	'unsigned long long':	{ bits: 64, unsigned: true,		suffix: 'ULL'	},
};

type IntKind	= keyof typeof INT_KINDS;
type FloatKind	= 'float' | 'double';
type ScalarKind	= IntKind | FloatKind;

export interface Scalar	{ kind: ScalarKind, value: number };

const isFloat	= (s: ScalarKind): s is FloatKind => s === 'float' || s === 'double';
const asBool	= (t: boolean) => ({ kind: 'bool', value: t ? 1 : 0 } as const);
const halfOf	= (bits: number) => 1n << BigInt(bits - 1);

const convertFloat	= (v: number, kind: ScalarKind) => {
	return kind === 'float' ?  Math.fround(v) : v;
};
const convertExact	= (v: number, kind: IntKind) => {
	const { bits, unsigned } = INT_KINDS[kind];
	return unsigned ? BigInt.asUintN(bits, BigInt(v)) : BigInt.asIntN(bits, BigInt(v));
};

function fromBig(v: bigint, kind: ScalarKind): Scalar | undefined {
	return v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)
		? undefined
		: { kind, value: Number(v) };
}
// An arithmetic result brought back into `kind`: unsigned wraps BY DEFINITION, while a signed result
// that doesn't fit is UB -- not a value to hand back, which `asIntN` saying so IS.
function asExact(v: bigint, kind: IntKind): Scalar | undefined {
	const { bits, unsigned } = INT_KINDS[kind];
	return unsigned ? fromBig(BigInt.asUintN(bits, v), kind)
		: BigInt.asIntN(bits, v) === v ? fromBig(v, kind) : undefined;
}

function asFloat(v: number, kind: FloatKind): Scalar | undefined {
	return Number.isFinite(v) ? { kind, value: kind === 'float' ? Math.fround(v) : v } : undefined;
}

// A bit pattern read back in `kind`: unsigned takes it as-is, signed as two's complement.
const fromBits = (v: bigint, kind: IntKind): Scalar | undefined => {
	const { bits, unsigned } = INT_KINDS[kind];
	return fromBig(unsigned ? BigInt.asUintN(bits, v) : BigInt.asIntN(bits, v), kind);
};

// C++'s usual arithmetic conversions between two integer types: a wider type represents every value of a narrower one (so `unsigned + long` is `long`), and at equal width the unsigned one wins.
function commonIntKind(a: IntKind, b: IntKind): IntKind {
	const A = INT_KINDS[a], B = INT_KINDS[b];
	return A.bits !== B.bits ? (A.bits > B.bits ? a : b) : (A.unsigned ? a : b);
}

/** Folds one binary operator over two literal operands, or undefined where C++ gives it no defined
 *  value at all -- which is a real answer here, not a failure: UB has no constant to fold to. */
export function calcBinary(op: C.binaryOps, a: Scalar, b: Scalar): Scalar | undefined {
	// `&&`/`||` convert both sides to `bool` and answer one -- unlike js, an operand is never the
	// result (`1 && 2` is `true`, not `2`).
	if (op === '&&')
		return asBool(a.value !== 0 && b.value !== 0);
	if (op === '||')
		return asBool(a.value !== 0 || b.value !== 0);
	// A comma sequences; it is not arithmetic, and collapsing it would hide that from a reader.
	if (op === ',')
		return undefined;

	const kind = a.kind === 'double' || b.kind === 'double' ? 'double'
	 	: a.kind === 'float' || b.kind === 'float' ? 'float'
		: commonIntKind(a.kind, b.kind);

	if (isFloat(kind)) {
		const x = convertFloat(a.value, kind), y = convertFloat(b.value, kind);
		// An integer operand is converted to the floating type C++ would use -- which for a `float` really
		// does round it.
		// A bitwise op, a shift or `%` on a floating-point operand is ill-formed in C++.
		switch (op) {
			case '==':	return asBool(x === y);
			case '!=':	return asBool(x !== y);
			case '<':	return asBool(x < y);
			case '<=':	return asBool(x <= y);
			case '>':	return asBool(x > y);
			case '>=':	return asBool(x >= y);
			case '+':	return asFloat(x + y, kind);
			case '-':	return asFloat(x - y, kind);
			case '*':	return asFloat(x * y, kind);
			case '/':	return asFloat(x / y, kind);
			return undefined;
		}
	} else {
		// Both operands are read in the type the operation happens in BEFORE anything is computed.
		const x = convertExact(a.value, kind), y = convertExact(b.value, kind);
		const bits	= INT_KINDS[kind].bits;
		switch (op) {
			case '==':	return asBool(x === y);
			case '!=':	return asBool(x !== y);
			case '<':	return asBool(x < y);
			case '<=':	return asBool(x <= y);
			case '>':	return asBool(x > y);
			case '>=':	return asBool(x >= y);
			case '+':	return asExact(x + y, kind);
			case '-':	return asExact(x - y, kind);
			case '*':	return asExact(x * y, kind);
			// BigInt's own `/` and `%` already match C++: truncated toward zero, remainder taking the dividend's sign. Division by zero is UB, and so is the one overflow with no value, `INT_MIN / -1`.
			case '/':
			case '%':	return y === 0n || (x === -halfOf(bits) && y === -1n) ? undefined : asExact(op === '/' ? x / y : x % y, kind);
			// A negative shift count, a shift past the type's width, and a negative LEFT operand are UB; a shift that would overflow a signed type has no defined value either.
			case '<<':	return y < 0n || y >= BigInt(bits) || (!INT_KINDS[kind].unsigned && x < 0n) ? undefined : asExact(x << y, kind);
			// Shifting a negative signed value right is implementation-defined; gcc/clang shift arithmetically, which is what BigInt's own `>>` does.
			case '>>':	return y < 0n || y >= BigInt(bits) ? undefined : asExact(x >> y, kind);
			case '&':	return fromBits(x & y, kind);
			case '|':	return fromBits(x | y, kind);
			case '^':	return fromBits(x ^ y, kind);
		}
		return undefined;
	}
}

export function calcUnary(op: C.unaryOps, a: Scalar): Scalar | undefined {
	switch (op) {
		case '!':	return asBool(a.value === 0);
		case '+':	return a;			// the promotion IS the whole operation
		case '-':	return isFloat(a.kind)
			? asFloat(-a.value, a.kind as FloatKind)
			: asExact(-convertExact(a.value, a.kind as IntKind), a.kind as IntKind);
		// `~v` is `-v - 1` in two's complement, and is never defined for a floating-point operand.
		case '~':	return !isFloat(a.kind) ? asExact(-convertExact(a.value, a.kind as IntKind) - 1n, a.kind as IntKind) : undefined;
	}
	return undefined;	// `&`/`*`/`sizeof`: an address or a type's size is not a literal's value
}

// The scalar a literal's value and its own spelling describe -- the only type information there is
export function scalarFor(value: number, raw?: string): Scalar | undefined {
	// The lexer produces decimal literals only, so a `.` or an exponent can only mean a floating one.
	if (raw !== undefined && /[.eE]/.test(raw)) {
		const suffix = raw.slice(-1);
		if (suffix === 'l' || suffix === 'L')
			return undefined;	// `long double` is 80-bit on x86 -- no JS number holds one
		return { kind: suffix === 'f' || suffix === 'F' ? 'float' : 'double', value };
	}
	const suffix	= raw?.match(/[uUlL]+$/)?.[0] ?? '';
	const unsigned	= /[uU]/.test(suffix);
	const longs		= (suffix.match(/[lL]/g) ?? []).length;
	// An unsuffixed decimal literal takes the first type that fits it (`int`, then `long`), and a `u`
	// one likewise (`unsigned`, then `unsigned long`).
	if (longs === 0)
		return { kind: unsigned
			? (value > 4294967295 ? 'unsigned long' : 'unsigned')
			: (value > 2147483647 ? 'long' : 'int'), value };
	return { kind: longs === 1 ? (unsigned ? 'unsigned long' : 'long')
		: (unsigned ? 'unsigned long long' : 'long long'), value };
}

// A folded scalar's own spelling. The type has to survive the round trip -- and to survive a FURTHER fold, since this spelling is the type the next one reads -- so it carries a suffix
export function spellScalar(s: Scalar): string {
	if (s.kind === 'bool')
		return s.value ? 'true' : 'false';
	// A floating result has to keep a `.` or an exponent, or it would print as an INTEGER literal
	// (`1.0 + 2.0` must not come back as `3`), and a `-0` has to keep its sign.
	if (isFloat(s.kind))
		return (Object.is(s.value, -0) ? '-0.0'
			: Number.isInteger(s.value) ? s.value.toFixed(1)
			: String(s.value)) + (s.kind === 'float' ? 'f' : '');
	return String(s.value) + INT_KINDS[s.kind as IntKind].suffix;
}

//-----------------------------------------------------------------------------
// walk
//-----------------------------------------------------------------------------

export interface Kinds { definition: Definition; statement: Stmt; expression: Expr; classMember: ClassMember }

export interface Walker extends W.Walker<Kinds> {
	definitions:	(x: readonly Definition[]) => Definition[];
	statements:		(x: readonly Stmt[]) => Stmt[];
	module:			<M extends Module<Definition>>(x: M) => M;
}

type OnAST<U>		= W.OnAST<U, Walker>;

export function walker(
	onDefinition?:	OnAST<Definition>,
	onStatement?:	OnAST<Stmt>,
	onExpression?:	OnAST<Expr>,
	onClassMember?:	OnAST<ClassMember>,
): Walker {

	// ---- shared leaves (declarators, type-names, specifiers) ----
	// C's declarator/type-name system has no TS analogue -- there's no separate "Type" AST, so these are
	// walked inline wherever a specifiers/declarator field appears, the same way TS's walker inlines BindingTarget.
	// `Declarator` and `AbstractDeclarator` are structurally close (pointer/array/function wrapping) but differ
	// in whether they bottom out at `Identifier` or `undefined`, so they need two distinctly-typed mappers --
	// a single function returning their union isn't assignable back into either one specifically.

	const paramDecl			= (p: ParamDecl): ParamDecl => isPackParameter(p) ? p : mapObject(p, {specifiers: declSpec, declarator, default: mapExpression});

	const declarator = (d: Declarator): Declarator => {
		switch (d.type) {
			case 'identifier':			return d;
			case 'pointer':
			case 'reference':
			case 'rvalue_reference':	return mapObject(d, {to: declarator});
			case 'array':				return mapObject(d, {element: declarator, size: arraySize});
			case 'function':			return mapObject(d, {name: declarator, params: mapArrayA(paramDecl)});
		}
	};
	const abstractDeclarator = (d: AbstractDeclarator): AbstractDeclarator => {
		if (!d)
			return d;
		switch (d.type) {
			case 'pointer':
			case 'reference':
			case 'rvalue_reference':	return mapObject(d, {to: abstractDeclarator});
			case 'array':				return mapObject(d, {element: abstractDeclarator, size: arraySize});
			case 'function':			return mapObject(d, {name: abstractDeclarator, params: mapArrayA(paramDecl)});
		}
	};
	// `ArrayDecl.size` deliberately stays typed against C's plain (never-extended) TypeSpecifier -- see
	// c-parser.ts's comment on `ArrayDecl` (the `[type_specifier]` array-size form is obscure enough that
	// threading the cpp extension seam through the whole declarator system for it isn't worth it). Walking it
	// with the wide `typeSpecifier` mapper is still correct behavior; only the field's *declared* type is narrower.
	const arraySize 		= (s: C.TypeSpecifier | C.Expr) => isExpr(s) ? mapExpression(s) : typeSpecifier(s) as C.TypeSpecifier;
	const baseSpecifier		= (b: CPP.BaseSpecifier): CPP.BaseSpecifier => mapObject(b, {args: mapArray(a => mapObject(a, {value: typeNameOrExpr}))});

	const typeSpecifier = (t: TypeSpecifier): TypeSpecifier => {
		switch (t.type) {
			case 'struct':
			case 'union':
			case 'class':	return mapObject(t, {bases: mapArray(baseSpecifier), body: mapArrayA(mapClassMemberA)});
			case 'enum':	return mapObject(t, {base: typeSpecifier, members: mapArrayA(e => mapObject(e, {init: mapExpression}))});
			default:		return t; // 'ref', and cpp's GenericType/QualifiedType/DecltypeSpecifier (structurally opaque here)
		}
	};

	const declSpec			= <S extends DeclSpec>(s: S): S => mapObject(s, {type: typeSpecifier} as W.NodeMap<S>);
	const typeName			= (t: TypeName): TypeName => mapObject(t, {specifiers: declSpec, declarator: abstractDeclarator});
	const narrowTypeName	= (t: C.TypeName) => typeName(t) as C.TypeName;
	const typeNameOrExpr	= (v: TypeName | Expr) => isExpr(v) ? mapExpression(v) : typeName(v);
	const initDeclarator	= (d: InitDeclarator): InitDeclarator => isDeclarator(d) ? declarator(d) : mapObject(d, {declarator, initializer});
	const initializer		= (i: C.Initializer<Expr>): C.Initializer<Expr> => isExpr(i) ? mapExpression(i)! : mapObject(i, {elements: mapArrayA(initializer)});
	const memberInitializer	= (m: CPP.MemberInitializer): CPP.MemberInitializer => mapObject(m, {arguments: mapArrayA(mapExpressionA)});

	const templateParam = (p: CPP.TemplateParam): CPP.TemplateParam => mapObject(p, {
		nonType: declSpec,
		default: typeNameOrExpr,
	});
	const body = (b: Block) => mapObject(b, {body: mapArrayA(mapStatementA)});
	const catchClause		= (c: CPP.CatchClause): CPP.CatchClause => mapObject(c, {type: typeName, body});

	// A struct/class member's own declarators, and cpp's DeclaratorField (declarator + optional initializer).
	const structDeclarator = (d: CPP.StructDeclarator): CPP.StructDeclarator =>
		'declarator' in d ? mapObject(d, {declarator, initializer: mapExpression})
			: mapObject(d, {width: mapExpression});


	// ---- expressions ----

	const expression = (e: Expr): Expr => {
		switch (e.type) {
			case 'unary':
			case 'unary_post':			return mapObject(e, {operand: mapExpressionA});
			case 'binary':				return mapObject(e, {left: mapExpressionA, right: mapExpressionA});
			case 'assign':				return mapObject(e, {target: mapExpressionA, value: mapExpressionA});
			case 'conditional':			return mapObject(e, {test: mapExpressionA, consequent: mapExpressionA, alternate: mapExpressionA});
			case 'index':				return mapObject(e, {object: mapExpressionA, index: mapExpressionA});
			case 'member':
			case 'pointer_member':		return mapObject(e, {object: mapExpressionA});
			case 'call':				return mapObject(e, {callee: mapExpressionA, arguments: mapArrayA(mapExpressionA)});
			// `cast`/`sizeof_type` come from C's plain Expr (see cpp-parser.ts's `Expr` comment on why it isn't
			// widened) -- their TypeName stays narrow accordingly.
			case 'cast':				return mapObject(e, {typeAnnotation: narrowTypeName, expression: mapExpressionA});
			case 'sizeof_type':			return mapObject(e, {operand: narrowTypeName});
			// cpp
			case 'new':					return mapObject(e, {typeName: typeSpecifier, arguments: mapArray(mapExpressionA), size: mapExpression, placement: mapArray(mapExpressionA)});
			case 'delete':				return mapObject(e, {operand: mapExpressionA});
			case 'spread':				return mapObject(e, {operand: mapExpressionA});
			case 'cpp_cast':			return mapObject(e, {target: typeName, expression: mapExpressionA});
			case 'typeid':				return mapObject(e, {expression: mapExpression, target: typeName});
			case 'alignof':				return mapObject(e, {target: typeName});
			case 'functional_cast':		return mapObject(e, {arguments: mapArrayA(mapExpressionA)});
			case 'lambda':				return mapObject(e, {
				captures:	mapArrayA((c: CPP.LambdaCapture) => mapObject(c, {init: mapExpression})),
				params:		mapArrayA(paramDecl),
				returnType:	typeName,
				body,
			});
			// identifier / literal / char_literal / this / null_literal / qualified / sizeof_pack -- no nested AST.
			default:					return e;
		}
	};

	// ---- statements / definitions (share the declaration/typedef branch) ----

	const declarationLike = <S extends Declaration | TypedefDecl>(d: S): S =>
		mapObject(d, {
			specifiers:			declSpec,
			initDeclarators:	mapArray(initDeclarator),
			declarators:		mapArray(initDeclarator),
		} as W.NodeMap<S>);

	// `template<...> declaration` -- a class/struct/union head, a using-alias, or any other Definition variant.
	const templateDeclaration = (x: Definition | CPP.ClassSpecifier | CPP.UsingAlias): Definition | CPP.ClassSpecifier | CPP.UsingAlias | undefined => {
		switch (x.type) {
			case 'class':
			case 'struct':
			case 'union':		return mapObject(x, {bases: mapArray(baseSpecifier), body: mapArrayA(mapClassMemberA)});
			case 'using_alias': return mapObject(x, {target: typeName});
			default:			return mapDefinition(x);
		}
	};

	const methodTail	= (t: CPP.MethodTail): CPP.MethodTail => mapObject(t, {body});
	const ctorTail		= (t: CPP.CtorTail): CPP.CtorTail => mapObject(t, {initializerList: mapArray(memberInitializer), body});

	const definitionExtra = (d: Definition): Definition => {
		switch (d.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(d);
			case 'function_def':		return mapObject(d, {specifiers: declSpec, declarator, body});
			// cpp
			case 'namespace':
			case 'linkage':				return mapObject(d, {body: mapArrayA(mapDefinitionA)});
			case 'using_namespace':
			case 'using_decl':			return d;
			case 'using_alias':			return mapObject(d, {target: typeName});
			case 'template':			return mapObject(d, {
				params:			mapArrayA(templateParam),
				declaration:	templateDeclaration,
			});
			case 'static_assert':		return mapObject(d, {condition: mapExpressionA});
			case 'method_def':
			case 'operator_def':		return mapObject(d, {
				specifiers:	declSpec,
				params:		mapArrayA(paramDecl),
				tail:		methodTail,
			});
			case 'constructor_def':		return mapObject(d, {params: mapArrayA(paramDecl), tail: ctorTail});
			case 'destructor_def':		return mapObject(d, {tail: methodTail});
			case 'static_member_def':	return mapObject(d, {specifiers: declSpec, initializer: mapExpression, ctorArgs: mapArray(mapExpressionA)});
			default:					return d;
		}
	};


	const statementExtra = (s: Stmt): Stmt => {
		switch (s.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(s);
			case 'block':				return mapObject(s, {body: mapArrayA(mapStatementA)});
			case 'if':					return mapObject(s, {test: mapExpressionA, consequent: mapStatementA, alternate: mapStatement});
			case 'while':
			case 'do_while':			return mapObject(s, {test: mapExpressionA, body: mapStatementA});
			case 'for':					return mapObject(s, {
				init:		i => isExpr(i) ? mapExpression(i) : declarationLike(i),
				test:		mapExpression,
				update:		mapExpression,
				body:		mapStatementA,
			});
			case 'switch':				return mapObject(s, {discriminant: mapExpressionA, body: mapStatementA});
			case 'case':				return mapObject(s, {test: mapExpressionA, body: mapStatementA});
			case 'default':				return mapObject(s, {body: mapStatementA});
			case 'return':				return mapObject(s, {argument: mapExpression});
			case 'labeled':				return mapObject(s, {body: mapStatementA});
			// cpp
			case 'throw':				return mapObject(s, {argument: mapExpression});
			case 'try':					return mapObject(s, {body, handlers: mapArrayA(catchClause)});
			case 'range_for':			return mapObject(s, {specifiers: declSpec, declarator, range: mapExpressionA, body: mapStatementA});
			case 'static_assert':		return mapObject(s, {condition: mapExpressionA});
			case 'using_alias':			return mapObject(s, {target: typeName});
			case 'using_namespace':
			case 'using_decl':			return s;
			case 'expression':			return mapObject(s, {expression: mapExpressionA});
			// break / continue / goto / empty -- no nested AST.
			default:					return s;
		}
	};

	// ---- class members (cpp) ----

	const classMember = (m: ClassMember | {type: 'member_typedef'; specifiers: DeclSpec; declarators: CPP.StructDeclarator[]}): ClassMember => {
		switch (m.type) {
			case 'struct_member':		return mapObject(m, {specifiers: declSpec, declarators: mapArrayA(structDeclarator)});
			case 'member_typedef':		return mapObject(m, {specifiers: declSpec, declarators: mapArrayA(structDeclarator)}) as unknown as ClassMember;
			case 'access_label':		return m;
			case 'constructor':			return mapObject(m, {params: mapArrayA(paramDecl), initializerList: mapArray(memberInitializer), body});
			case 'destructor':			return mapObject(m, {body});
			case 'method':				return mapObject(m, {specifiers: declSpec, declarator, body});
			case 'conversion':			return mapObject(m, {target: typeName, body});
			case 'using_decl':			return m;
			case 'using_alias':			return mapObject(m, {target: typeName});
			case 'member_template':		return mapObject(m, {params: mapArrayA(templateParam), declaration: classMember});
			default:					return m;
		}
	};

	const definitions = mapArrayA((d: Definition) => mapDefinition(d));
	const recurse: Walker = {
		definition:		x => mapDefinition(x),
		statement:		x => mapStatement(x),
		expression:		x => mapExpression(x),
		classMember:	x => mapClassMember(x),
		definitions,
		statements:		mapArrayA((s: Stmt) => mapStatement(s)),
		module:			x => ({...x, body: definitions(x.body)}),
	};

	const mapStatement		= makeProcess(statementExtra, onStatement, recurse, true);
	const mapDefinition		= makeProcess(definitionExtra, onDefinition, recurse, true);
	const mapExpression		= makeProcess(expression, onExpression, recurse);
	const mapClassMember	= makeProcess(classMember, onClassMember, recurse, true);

	const mapExpressionA	= mapDefined(mapExpression);
	const mapStatementA		= mapDefined(mapStatement);
	const mapDefinitionA	= mapDefined(mapDefinition);
	const mapClassMemberA	= mapDefined(mapClassMember);

	return recurse;
}

//-----------------------------------------------------------------------------
// walkB
//-----------------------------------------------------------------------------

export interface WalkerB extends W.WalkerB<Kinds> {
	definitions:	(x: readonly Definition[]) => boolean;
	statements:		(x: readonly Stmt[]) => boolean;
}
type OnASTB<U>		= W.OnASTB<U, WalkerB>;

export function walkerB(
	onDefinition?:	OnASTB<Definition>,
	onStatement?:	OnASTB<Stmt>,
	onExpression?:	OnASTB<Expr>,
	onClassMember?:	OnASTB<ClassMember>,
): WalkerB {

	const walkDeclarator = (d?: Declarator | AbstractDeclarator): boolean => {
		if (!d)
			return false;
		switch (d.type) {
			case 'identifier':			return false;
			case 'pointer':
			case 'reference':
			case 'rvalue_reference':	return walkDeclarator(d.to);
			case 'array':				return walkDeclarator(d.element) || (isExpr(d.size) ? walkExpression(d.size) : walkTypeSpecifier(d.size));
			case 'function':			return walkDeclarator(d.name) || d.params.some(walkParamDecl);
		}
	};

	const walkTypeSpecifier = (t?: TypeSpecifier): boolean => {
		if (!t)
			return false;
		switch (t.type) {
			case 'struct':
			case 'union':
			case 'class':	return !!t.body?.some(walkClassMember);
			case 'enum':	return !!t.members?.some(m => walkExpression(m.init));
			default:		return false;
		}
	};
	const walkDeclSpec			= (s?: DeclSpec) => !!s && walkTypeSpecifier(s.type);
	const walkTypeName			= (t?: TypeName) => !!t && (walkDeclSpec(t.specifiers) || walkDeclarator(t.declarator));
	const walkParamDecl			= (p: ParamDecl) => isPackParameter(p) ? false : walkDeclSpec(p.specifiers) || walkDeclarator(p.declarator) || walkExpression(p.default);
	const walkInitDeclarator	= (d: InitDeclarator) => isDeclarator(d) ? walkDeclarator(d) : walkDeclarator(d.declarator) || walkInitializer(d.initializer);
	const walkInitializer		= (i?: C.Initializer<Expr>) => !i ? false : isExpr(i) ? walkExpression(i) : i.elements.some(walkInitializer);
	const walkStructDeclarator	= (d: CPP.StructDeclarator) => 'declarator' in d ? walkDeclarator(d.declarator) || walkExpression(d.initializer) : walkExpression(d.width);
	const walkStructMember		= (m: CPP.StructMember) => walkDeclSpec(m.specifiers) || m.declarators.some(walkStructDeclarator);
	const walkTemplateArg		= (a: CPP.TemplateArg) => isExpr(a.value) ? walkExpression(a.value) : walkTypeName(a.value);
	const walkTemplateParam		= (p: CPP.TemplateParam) => walkDeclSpec(p.nonType) || (!!p.default && (isExpr(p.default) ? walkExpression(p.default) : walkTypeName(p.default)));
	const walkBaseSpecifier		= (b: CPP.BaseSpecifier) => !!b.args?.some(walkTemplateArg);
	const walkCatchClause		= (c: CPP.CatchClause) => walkTypeName(c.type) || c.body.body.some(walkStatement);
	const walkMemberInitializer	= (m: CPP.MemberInitializer) => m.arguments.some(walkExpression);
	const walkBlock				= (b?: Block) => !!b && b.body.some(walkStatement);
	const walkMethodOrCtorTail	= (t: CPP.MethodTail | CPP.CtorTail) =>
		'initializerList' in t ? (!!t.initializerList?.some(walkMemberInitializer) || walkBlock(t.body))
			: walkBlock((t as CPP.MethodTail).body);

	const expression = (e: Expr) => {
		switch (e.type) {
			case 'unary':
			case 'unary_post':			return walkExpression(e.operand);
			case 'binary':				return walkExpression(e.left) || walkExpression(e.right);
			case 'assign':				return walkExpression(e.target) || walkExpression(e.value);
			case 'conditional':			return walkExpression(e.test) || walkExpression(e.consequent) || walkExpression(e.alternate);
			case 'index':				return walkExpression(e.object) || walkExpression(e.index);
			case 'member':
			case 'pointer_member':		return walkExpression(e.object);
			case 'call':				return walkExpression(e.callee) || e.arguments.some(walkExpression);
			case 'cast':				return walkTypeName(e.typeAnnotation) || walkExpression(e.expression);
			case 'sizeof_type':			return walkTypeName(e.operand);
			// cpp
			case 'new':					return walkTypeSpecifier(e.typeName) || !!e.arguments?.some(walkExpression) || walkExpression(e.size) || !!e.placement?.some(walkExpression);
			case 'delete':				return walkExpression(e.operand);
			case 'spread':				return walkExpression(e.operand);
			case 'cpp_cast':			return walkTypeName(e.target) || walkExpression(e.expression);
			case 'typeid':				return walkExpression(e.expression) || walkTypeName(e.target);
			case 'alignof':				return walkTypeName(e.target);
			case 'functional_cast':		return e.arguments.some(walkExpression);
			case 'lambda':				return e.captures.some(c => walkExpression(c.init)) || e.params.some(walkParamDecl) || walkTypeName(e.returnType) || walkBlock(e.body);
			default:					return false;
		}
	};

	const declarationLike = (d: Declaration | TypedefDecl) =>
		walkDeclSpec(d.specifiers)
		|| (d.type === 'typedef' ? d.declarators.some(walkInitDeclarator) : !!d.initDeclarators?.some(walkInitDeclarator));

	const definition = (d: Definition): boolean => {
		switch (d.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(d);
			case 'function_def':		return walkDeclSpec(d.specifiers) || walkDeclarator(d.declarator) || walkBlock(d.body);
			// cpp
			case 'namespace':
			case 'linkage':				return d.body.some(walkDefinition);
			case 'using_alias':			return walkTypeName(d.target);
			case 'template':			return d.params.some(walkTemplateParam) || (
				d.declaration.type === 'class' || d.declaration.type === 'struct' || d.declaration.type === 'union'
					? !!d.declaration.bases?.some(walkBaseSpecifier) || !!d.declaration.body?.some(walkClassMember)
					: d.declaration.type === 'using_alias' ? walkTypeName(d.declaration.target)
					: walkDefinition(d.declaration as Definition)
			);
			case 'static_assert':		return walkExpression(d.condition);
			case 'method_def':
			case 'operator_def':		return walkDeclSpec(d.specifiers) || d.params.some(walkParamDecl) || walkMethodOrCtorTail(d.tail);
			case 'constructor_def':		return d.params.some(walkParamDecl) || walkMethodOrCtorTail(d.tail);
			case 'destructor_def':		return walkMethodOrCtorTail(d.tail);
			case 'static_member_def':	return walkDeclSpec(d.specifiers) || walkExpression(d.initializer) || !!d.ctorArgs?.some(walkExpression);
			default:					return false;
		}
	};

	const statement = (s: Stmt): boolean => {
		switch (s.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(s);
			case 'block':				return s.body.some(walkStatement);
			case 'if':					return walkExpression(s.test) || walkStatement(s.consequent) || (!!s.alternate && walkStatement(s.alternate));
			case 'while':
			case 'do_while':			return walkExpression(s.test) || walkStatement(s.body);
			case 'for':					return (s.init ? (isExpr(s.init) ? walkExpression(s.init) : declarationLike(s.init)) : false) || walkExpression(s.test) || walkExpression(s.update) || walkStatement(s.body);
			case 'switch':				return walkExpression(s.discriminant) || walkStatement(s.body);
			case 'case':				return walkExpression(s.test) || walkStatement(s.body);
			case 'default':				return walkStatement(s.body);
			case 'return':				return walkExpression(s.argument);
			case 'labeled':				return walkStatement(s.body);
			// cpp
			case 'throw':				return walkExpression(s.argument);
			case 'try':					return s.body.body.some(walkStatement) || s.handlers.some(walkCatchClause);
			case 'range_for':			return walkDeclSpec(s.specifiers) || walkDeclarator(s.declarator) || walkExpression(s.range) || walkStatement(s.body);
			case 'static_assert':		return walkExpression(s.condition);
			case 'using_alias':			return walkTypeName(s.target);
			case 'expression':			return walkExpression(s.expression);
			default:					return false;
		}
	};

	const classMember = (m: ClassMember): boolean => {
		switch (m.type) {
			case 'struct_member':		return walkStructMember(m);
			case 'constructor':			return m.params.some(walkParamDecl) || !!m.initializerList?.some(walkMemberInitializer) || walkBlock(m.body);
			case 'destructor':			return walkBlock(m.body);
			case 'method':				return walkDeclSpec(m.specifiers) || walkDeclarator(m.declarator) || walkBlock(m.body);
			case 'conversion':			return walkTypeName(m.target) || walkBlock(m.body);
			case 'using_alias':			return walkTypeName(m.target);
			case 'member_template':		return m.params.some(walkTemplateParam) || walkClassMember(m.declaration);
			default:					return (m as unknown as {type: 'member_typedef'; specifiers: DeclSpec; declarators: CPP.StructDeclarator[]}).type === 'member_typedef'
				? walkDeclSpec((m as any).specifiers) || (m as any).declarators.some(walkStructDeclarator)
				: false;
		}
	};
	const recurse: WalkerB = {
		definition:		x => walkDefinition(x),
		statement:		x => walkStatement(x),
		expression:		x => walkExpression(x),
		classMember:	x => walkClassMember(x),
		definitions:	x => x.some(walkDefinition),
		statements:		x => x.some(walkStatement),
	};

	const walkStatement		= makeProcessB(statement, onStatement, recurse, true);
	const walkDefinition	= makeProcessB(definition, onDefinition, recurse, true);
	const walkExpression	= makeProcessB(expression, onExpression, recurse);
	const walkClassMember	= makeProcessB(classMember, onClassMember, recurse, true);

	return recurse;
}
