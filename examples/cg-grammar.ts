/* eslint-disable @typescript-eslint/no-this-alias */
import { makeParser, makeRule, Rules, List, terminal, Forward, TextPos } from '../src/tison';

const Rule		= makeRule<CG>();
type ident		= number;

type NumericStatics<T> = { [K in keyof T]: T[K] extends number ? T[K] : never }[keyof T];

function duplicate(a: object) {
	return Object.assign(Object.create(Object.getPrototypeOf(a)), a);
}

// symbols
const
	AND_SY         	= "&&",
	ASSIGNMINUS_SY 	= "-=",
	ASSIGNMOD_SY   	= "%=",
	ASSIGNPLUS_SY  	= "+=",
	ASSIGNSLASH_SY 	= "/=",
	ASSIGNSTAR_SY  	= "*=",
	ASSIGNAND_SY  	= "&=",
	ASSIGNOR_SY  	= "|=",
	ASSIGNXOR_SY  	= "^=",
	ASM_SY         	= "asm",
	BOOLEAN_SY     	= "boolean",
	BREAK_SY       	= "break",
	CASE_SY        	= "case",
	COLONCOLON_SY  	= "::",
	CONST_SY       	= "const",
	CONTINUE_SY    	= "continue",
	DEFAULT_SY     	= "default",
	DISCARD_SY     	= "discard",
	DO_SY          	= "do",
	EQ_SY          	= "==",
	ELSE_SY        	= "else",
	EXTERN_SY      	= "extern",
	FLOAT_SY       	= "float",
	FOR_SY         	= "for",
	GE_SY          	= ">=",
	GG_SY          	= ">>",
	GOTO_SY        	= "goto",
	IDENT_SY       	= "<ident>",
	PASTING_SY		= "##",
	IF_SY          	= "if",
	IN_SY          	= "in",
	INLINE_SY      	= "inline",
	INOUT_SY       	= "inout",
	INT_SY         	= "int",
	UNSIGNED_SY    	= "unsigned",
	INTERNAL_SY    	= "__internal",
	LE_SY          	= "<=",
	LL_SY          	= "<<",
	MINUSMINUS_SY  	= "--",
	NE_SY          	= "!=",
	OR_SY          	= "||",
	OUT_SY         	= "out",
	_PACKED_SY     	= "__packed",
	PACKED_SY      	= "packed",
	PLUSPLUS_SY    	= "++",
	RETURN_SY      	= "return",
	STATIC_SY      	= "static",
	STRUCT_SY      	= "struct",
	STRCONST_SY    	= "<string-const>",
	SWITCH_SY      	= "switch",
	THIS_SY        	= "this",
	TYPEDEF_SY     	= "typedef",
	TYPEIDENT_SY   	= "<type-ident>",
	TEMPLATEIDENT_SY	= "<template-ident>",
	UNIFORM_SY     	= "uniform",
	VOID_SY        	= "void",
	WHILE_SY       	= "while",
	SAMPLERSTATE_SY	= "sampler_state",
	TECHNIQUE_SY	= "technique",
	PASS_SY			= "pass",
	COMPILE_SY		= "compile",
	ROWMAJOR_SY		= "row_major",
	COLMAJOR_SY		= "column_major",
	NOINTERP_SY		= "nointerpolation",
	PRECISE_SY		= "precise",
	SHARED_SY		= "shared",
	GROUPSHARED_SY	= "groupshared",
	VOLATILE_SY		= "volatile",
	REGISTER_SY		= "register",
	ENUM_SY			= "enum",
	LOWP_SY			= "lowp",
	MEDIUMP_SY		= "mediump",
	HIGHP_SY		= "highp",
	CBUFFER_SY		= "ConstantBuffer",
	TEMPLATE_SY		= "template",
	OPERATOR_SY		= "operator",
	TEXOBJ_SY		= "<texobj-type>",
	ERROR_SY		= "$error";

enum TEXOBJ {
	ANYTEX	= 0,
	_1D,
	_2D,
	_2DMS,
	_3D,
	CUBE,
	RECT,
	SHADOW,

	BUFFER,
	BYTE,
	STRUCTURED,
	APPEND,
	CONSUME,
	INPUTPATCH,
	OUTPUTPATCH,

	ARRAY	= 32,
	SAMPLER	= 64,
	RW		= 128,
};

enum SC {//StorageClass {
	UNKNOWN,
	AUTO,
	STATIC,
	EXTERN,
	NOINTERP,
	PRECISE,
	SHARED,
	GROUPSHARED,
};

type KIND = NumericStatics<typeof Expr>;

enum SUB {
	NONE, S, V, VS, SV, M, VM, MV,
	Z, ZM, CS, CV, CM, KV,
};


// `Expr` has to be declared before `OP` below, since `OP`'s entries reference `Expr.SYMB` etc. as values
// (not just types) -- a class isn't usable as a value before its declaration, unlike a type alias.
class Expr {
	static readonly DECL		= 0;
	static readonly SYMB		= 1;
	static readonly CONST		= 2;
	static readonly UNARY		= 3;
	static readonly BINARY		= 4;
	static readonly TRINARY		= 5;
	static readonly SYMBOLIC	= 6;

	is_lvalue		= false;
	is_const		= false;
	has_sideeffects	= false;

	sym?: {
		symbol:	Sym;
	};
	constant?: {
		subop?:	number;
		val:	number|number[]|string;
	};
	unary?: {
		subop?:	number;
		arg:	Expr;
	};
	binary?: {
		subop?:	number;
		left:	Expr;
		right?:	Expr;
	};
	trinary?: {
		subop?:	number;
		arg1:	Expr;
		arg2:	Expr;
		arg3:	Expr;
	};
	symbolic?: {
		name:	number;
		name2:	number;
	};

	constructor(public op: opcode, public kind: KIND, public type?: Type) {
	}

	static NewSymbNode(op: opcode, sym: Sym) {
		const e = new Expr(op, Expr.SYMB, sym.type);
		e.is_lvalue		= true;
		e.is_const		= !!((e.type?.GetQualifiers() ?? 0) & Type.QUALIFIER_CONST);
		e.sym			= { symbol: sym };
		return e;
	}
	static NewConstNode(op: opcode, val: number | number[] | string, base: number) {
		const e = new Expr(op, Expr.CONST);//, GetStandardType(this.hal, base, array, 0));
		e.is_const		= true;
		e.constant		= {val};
		return e;
	}
	static NewUnopNode(op: opcode, arg: Expr, type?: Type, subop = 0) {
		const e = new Expr(op, Expr.UNARY, type);
		e.has_sideeffects = arg && arg.has_sideeffects;
		e.unary		= {subop, arg};
		return e;
	}
	static NewBinopNode(op: opcode, left: Expr, right?: Expr, subop = 0) {
		const e = new Expr(op, Expr.BINARY);
		e.has_sideeffects = (left && left.has_sideeffects) || (right ? right.has_sideeffects : false);
		e.binary = {subop, left, right};
		return e;
	}
	static NewTriopNode(op: opcode, arg1: Expr, arg2: Expr, arg3: Expr, subop = 0) {
		const e = new Expr(op, Expr.TRINARY);
		e.has_sideeffects = (arg1 && arg1.has_sideeffects) || (arg2 && arg2.has_sideeffects) || (arg3 && arg3.has_sideeffects);
		e.trinary = {subop, arg1, arg2, arg3};
		return e;
	}
};

class Scope {
	static has_void_param	= 1 << 0;
	static has_return		= 1 << 1;
	static is_struct		= 1 << 2;
	static is_cbuffer		= 1 << 3;
	static has_semantics	= 1 << 4;

	next?: 			Scope;
	prev?: 			Scope;		// doubly-linked list of all scopes

	parent?:		Scope;
	func_scope?:	Scope;		// Points to base scope of enclosing function
	symbols:		Sym[] = [];
	tags:			Sym[] = [];
	params:			Sym[] = [];
	rettype?:		Type;

	level			= 0;			// 0 = super globals, 1 = globals, etc.
	funindex		= 0;			// Identifies which function contains scope
	formal			= 0;			// > 0 when parsing formal parameters.
	pid				= 0;			// Program type id
	flags			= 0;

	init_stmts:	Stmt[]	= [];		// Global initialization statements (Only used at global scope (level 1):)
	
	constructor() {
	}
	push(child: Scope) {
		child.level = this.level + 1;
		if (!child.func_scope)
			child.func_scope = this.func_scope;
		child.parent = this;
	}

	LookUpSymbol(atom: ident) {
		for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
			const sym = scope.symbols.find(s => s.name == atom);
			if (sym)
				return sym;
		}
	}
	LookUpTag(atom: ident) {
		for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
			const sym = scope.tags.find(s => s.name == atom);
			if (sym)
				return sym;
		}
	}
};

class Binding {
	static readonly NONE		= 0;
	static readonly CONNECTOR	= 1;
	static readonly TEXUNIT		= 2;
	static readonly REGARRAY	= 3;
	static readonly CONSTANT	= 4;
	static readonly DEFAULT		= 5;
	static readonly SEMANTIC	= 6;
	static readonly CONSTBUFFER	= 7;
	static readonly FLAG = {
		IS_BOUND:           0x0001,
		HIDDEN:             0x0002,
		UNIFORM:            0x0004,
		VARYING:            0x0008,
		INPUT:              0x0010,
		OUTPUT:             0x0020,
		WRITE_REQUIRED:     0x0040,
		WAS_WRITTEN:        0x0080,
	};

	properties	= 0;	// Properties
	size		= 0;	// num of elements
	rname		= 0;	// HW Register name or semantic name
	regno		= 0;	// or unit or semantic index

	reg?: {
		count:	number;	// Number of registers allocated
		parent:	Binding;
	};
	constdef?: {
		values:	number[];	// Values
	};
	
	constructor(public gname = 0, public lname = 0, public kind = Binding.NONE) {}
};

class Sym {
	static readonly VARIABLE	= 0;
	static readonly TYPEDEF		= 1;
	static readonly TEMPLATE	= 2;
	static readonly FUNCTION	= 3;
	static readonly CONSTANT	= 4;
	static readonly TAG			= 5;
	static readonly MACRO		= 6;
	static readonly TECHNIQUE	= 7;
	static FLAGS = {
		IS_PARAMETER:			0x000001,	// Symbol is a formal parameter
		IS_DEFINED:				0x000002,	// Symbol is defined.	Currently only used for functions.
		IS_BUILTIN:				0x000004,	// Symbol is a built-in function.
		IS_INLINE_FUNCTION:		0x000008,	// Symbol is a function that will be inlined.
		IS_CONNECTOR_REGISTER:	0x000010,	// Symbol is a connector hw register
		CONNECTOR_CAN_READ:		0x000020,	// Symbol is a readable connector hw register
		CONNECTOR_CAN_WRITE:	0x000040,	// Symbol is a writable connector hw register
		NEEDS_BINDING:			0x000080,	// Symbol is a non-static global and has not yet been bound
	};
	left?:		Sym;
	right?:		Sym;
	next?:		Sym;
	loc?:		TextPos;
	properties	= 0;
	storage		= SC.UNKNOWN;

	fun?: {
		locals:		Scope;
		params:		Sym;
		statements:	Stmt;
		overload:	Sym;	// List of overloaded versions of this function
		flags:		number;		// Used when resolving overloaded reference
		group:		number;		// Built-in function group
		index:		number;		// Built-in function index
		semantics:	number;
	};
	
	var?: {
		addr:		number;		// Address or member offset
		semantics:	number;
		bind:		Binding;
		init:		Expr;		// For initialized non-static globals
	};
	
	con?: {
		value:	number;		// Constant value: 0 = false, 1 = true
	};
	
//	mac:	MacroSymbol;
	constructor(public name: ident, public kind: SymKind, public type: Type) {
	}

	IsTypedef()		{ return this.kind == Sym.TYPEDEF;}
	IsTemplate()	{ return this.kind == Sym.TEMPLATE;}
	IsFunction()	{ return this.kind == Sym.FUNCTION;}
	IsInline()		{ return this.IsFunction() && (this.properties & Sym.FLAGS.IS_INLINE_FUNCTION);}
};
type SymKind = NumericStatics<typeof Sym>;


class Type {
	static BASE_MASK				= 0x0000000f;
	static BASE_SHIFT				= 0;
	static BASE_BITS				= 4;
	static BASE_NO_TYPE				= 0; // e.g. struct or connector
	static BASE_UNDEFINED_TYPE		= 1;
	static BASE_CFLOAT				= 2;
	static BASE_CINT				= 3;
	static BASE_VOID				= 4;
	static BASE_FLOAT				= 5;
	static BASE_INT					= 6;
	static BASE_BOOLEAN				= 7;
	static BASE_UINT				= 8;
	static BASE_TEXOBJ				= 9;
	static BASE_STRING				= 10;
	static BASE_HALF				= 11;
	static BASE_FIRST_USER			= 12;
	static BASE_LAST_USER			= 0x0000000f;

	static CATEGORY_MASK			= 0x000000f0;
	static CATEGORY_SHIFT			= 4;
	static CATEGORY_NONE			= 0x00000000;
	static CATEGORY_SCALAR			= 0x00000010;
	static CATEGORY_ARRAY			= 0x00000020;
	static CATEGORY_FUNCTION		= 0x00000030;
	static CATEGORY_STRUCT			= 0x00000040;
	static CATEGORY_TEXOBJ			= 0x00000050;
	static CATEGORY_ENUM			= 0x00000060;

	static DOMAIN_MASK				= 0x00000f00;
	static DOMAIN_SHIFT				= 8;
	static DOMAIN_UNKNOWN			= 0x00000000;
	static DOMAIN_UNIFORM			= 0x00000100;
	static DOMAIN_VARYING			= 0x00000200;

	static QUALIFIER_MASK			= 0x0000f000;
	static QUALIFIER_NONE			= 0x00000000;
	static QUALIFIER_CONST			= 0x00001000;
	static QUALIFIER_IN				= 0x00002000;
	static QUALIFIER_OUT			= 0x00004000;
	static QUALIFIER_INOUT			= this.QUALIFIER_IN | this.QUALIFIER_OUT;

	static MISC_MASK				= 0x7ff00000;
	static MISC_TYPEDEF				= 0x00100000;
//	static MISC_UNSIGNED			= 0x00200000;
	static MISC_ABSTRACT_PARAMS		= 0x00400000;	// Type is function declared with abstract parameters
//	static MISC_VOID				= 0x00800000;	// Type is void
	static MISC_INLINE				= 0x01000000;	// "static inline" function attribute
	static MISC_INTERNAL			= 0x02000000;	// "__internal" function attribute
	static MISC_PACKED				= 0x04000000;	// For vector types like float3
	static MISC_PACKED_KW			= 0x08000000;	// Actual "packed" keyword used
	static MISC_ROWMAJOR			= 0x10000000;
	static MISC_PRECISION			= 0x20000000;	// precision for glsl: 0=def; 1=low; 2=med; 3=high
	static MISC_MARKED				= 0x80000000;	// Temp value for printing types; etc.

	size		= 0;
	subtype?:	Type;

	arr?: {
		numels:			number;
	};
	str?: {						// for structs and connectors and templates
		base:			Type;
		members:		Scope;
		tag:			number;			// struct or connector tag
		semantics:		number;
	};
	fun?: {
		paramtypes:		Type[];
	};	
	tex?: {	
		eltype:			Type;
		dims:			number;	//1D, 2D, 3D, Cube, rect
	};	
	enm?: {	
		tag:			number;
		members:		Scope;
	};	
	typname?: {
		index:			number;
	};

	constructor(public properties: number) {
	}

	GetProperties(mask: number)		{ return this.properties & mask; }
	ClearProperties(mask: number)	{ this.properties &= ~mask; }
	SetProperties(mask: number, value: number)	{ this.properties = (this.properties& ~mask) | value; }
	IsProperties(mask: number, value: number)	{ return (this.properties & mask) === value; }
	TestBit(mask: number)			{ return !!(this.properties & mask); }

	GetQuadRegSize()				{ return (this.size + 3) >> 2; }

	GetBase()						{ return this.GetProperties(Type.BASE_MASK); }
	GetCategory()					{ return this.GetProperties(Type.CATEGORY_MASK); }
	GetDomain()						{ return this.GetProperties(Type.DOMAIN_MASK); }
	GetQualifiers()					{ return this.GetProperties(Type.QUALIFIER_MASK); }

	SetCategory(category: number)	{ this.SetProperties(Type.CATEGORY_MASK, category); }
	SetDomain(domain: number)		{ this.SetProperties(Type.DOMAIN_MASK, domain); }

	IsTypeBase(base: number)		{ return this.GetBase() == base; }
	IsVoid()						{ return this.GetBase() == Type.BASE_VOID; }
	IsBoolean()						{ return this.GetBase() == Type.BASE_BOOLEAN; }

	IsCategory(category: number)	{ return this.GetCategory() == category; }
	IsScalar()						{ return this.GetCategory() == Type.CATEGORY_SCALAR; }
	IsEnum()						{ return this.GetCategory() == Type.CATEGORY_ENUM; }
	IsStruct()						{ return this.GetCategory() == Type.CATEGORY_STRUCT; }
	IsArray()						{ return this.GetCategory() == Type.CATEGORY_ARRAY; }

	IsOut() 						{ return this.TestBit(Type.QUALIFIER_OUT); }
	IsConst() 						{ return this.TestBit(Type.QUALIFIER_CONST); }
	IsPacked()						{ return this.TestBit(Type.MISC_PACKED); }
	IsUnsizedArray()				{ return this.IsArray() && this.arr!.numels == 0; }

	AddStructBase(type: Type) 		{ return this; }
	InstantiateTemplate(types: Type[])	{ return this; }

};

class Attr {
	name:	ident;
	params:	number[];
	next?:	Attr;
	constructor(name: ident, ...params: number[]) {
		this.name	= name;
		this.params	= params;
	}
};

class Stmt {
	static readonly EXPR	= 0;
	static readonly IF		= 1;
	static readonly WHILE	= 2;
	static readonly DO		= 3;
	static readonly FOR		= 4;
	static readonly SWITCH	= 5;
	static readonly BLOCK	= 6;
	static readonly RETURN	= 7;
	static readonly DISCARD	= 8;
	static readonly BREAK	= 9;
	static readonly COMMENT	= 10;

	kind:			NumericStatics<typeof Stmt>;
//	next?:			Stmt;
	attributes?:	Attr;
	loc:			TextPos;

	expr_stmt?: {
		exp:		Expr;
	};
	if_stmt?: {
		cond:		Expr;
		thenstmt:	Stmt;
		elsestmt?:	Stmt;
	};
	while_stmt?: {
		cond:		Expr;
		body:		Stmt;
	};
	for_stmt?: {
		init?:		Stmt;
		cond:		Expr;
		step?:		Stmt;
		body:		Stmt;
	};
	switch_stmt?: {
		cond:		Expr;
		cases:		Stmt[];
		scope:		Scope;
	};
	block_stmt?: {
		body:		Stmt[];
		scope:		Scope;
	};
	return_stmt?: {
		exp:		Expr;
	};
	discard_stmt?: {
		cond:		Expr;
	};
	comment_stmt?: {
		str:		string;
	};
	constructor(kind: NumericStatics<typeof Stmt>, loc: TextPos) {
		this.kind = kind;
		this.loc = loc;
	}
	AddAttribute(attr: Attr) {
		attr.next = this.attributes;
		this.attributes = attr;
		return this;
	}
	Check() { return this; }
	SetThenElseStmts(thenstmt: Stmt, elsestmt?: Stmt) {
		this.if_stmt!.thenstmt = thenstmt;
		this.if_stmt!.elsestmt = elsestmt;
		return this;
	}
};

// Possibly derived, stack-resident pointer to and copy of a type.
class Derived {
	basetype:		Type;		// Pointer to non-derived
	is_derived:		boolean;	// TRUE if anything has been altered
	num_new_dims:	number;		// Number of new dimensions added for this declarator
	storage:		SC;			// Aplied to variables when defined, not part of the type
	type:			Type;		// Local copy of type

	constructor(basetype: Type, category: number) {
		this.basetype		= basetype;
		this.is_derived		= true;
		this.num_new_dims	= 0;
		this.storage		= SC.UNKNOWN;
		this.type			= new Type(category);
		return this;
	}
	SetDType(type: Type) {
		this.basetype		= type;
		this.is_derived		= false;
		this.num_new_dims	= 0;
		this.storage		= SC.UNKNOWN;
		this.type			= type;
		return this;
	}
};

// For declaration parsing
class Decl {
	loc?:			TextPos;	// Location for error reporting
	semantics		= 0;
	type?:			Derived;	// Type collected while parsing
	symb?:			Sym;		// Symbol table definition of actual object
	params?:		Decl;		// Actual paramaters to function declaration
	initexpr?:		Expr;		// Initializer
	attributes?:	Attr;

	constructor(public name: ident, public kind: KIND) {
	}
	AddAttribute(attr: Attr) {
		attr.next = this.attributes;
		this.attributes = attr;
		return this;
	}
};


function Op(name: string, sym: string|number, sym2: string|number, kind: KIND, subkind: SUB): {name: string; sym: string|number; sym2: string|number; kind: KIND; subkind: SUB} {
	return {name, sym, sym2, kind, subkind};
}

const OP = {
	VARIABLE:		Op("var",		IDENT_SY,		0,		Expr.SYMB,	SUB.NONE),
	MEMBER:			Op("member",	IDENT_SY,		0,		Expr.SYMB,	SUB.NONE),
	
	ICONST:			Op("iconst",	0,				0,		Expr.CONST,	SUB.S	),
	ICONST_V:		Op("iconstv",	0,				0,		Expr.CONST,	SUB.V	),
	BCONST:			Op("bconst",	0,				0,		Expr.CONST,	SUB.S	),
	BCONST_V:		Op("bconstv",	0,				0,		Expr.CONST,	SUB.V	),
	FCONST:			Op("fconst",	0,				0,		Expr.CONST,	SUB.S	),
	FCONST_V:		Op("fconstv",	0,				0,		Expr.CONST,	SUB.V	),
	UCONST:			Op("uconst",	0,				0,		Expr.CONST,	SUB.S	),
	UCONST_V:		Op("uconstv",	0,				0,		Expr.CONST,	SUB.V	),
	HCONST:			Op("hconst",	0,				0,		Expr.CONST,	SUB.S	),
	HCONST_V:		Op("hconstv",	0,				0,		Expr.CONST,	SUB.V	),
	XCONST:			Op("xconst",	0,				0,		Expr.CONST,	SUB.S	),
	XCONST_V:		Op("xconstv",	0,				0,		Expr.CONST,	SUB.V	),
	
	VECTOR_V:		Op("vector",	0,				0,		Expr.UNARY,	SUB.V	),
	MATRIX_M:		Op("matrix",	0,				0,		Expr.UNARY,	SUB.M	),
	SWIZZLE_Z:		Op("swizzle",	'.',			0,		Expr.UNARY,	SUB.Z	),
	SWIZMAT_Z:		Op("swizmat",	'.',			0,		Expr.UNARY,	SUB.ZM	),
	CAST_CS:		Op("cast",		'(',			0,		Expr.UNARY,	SUB.CS	),
	CAST_CV:		Op("castv",		'(',			0,		Expr.UNARY,	SUB.CV	),
	CAST_CM:		Op("castm",		'(',			0,		Expr.UNARY,	SUB.CM	),
	NEG:			Op("neg",		'-',			"-",	Expr.UNARY,	SUB.S	),
	NEG_V:			Op("negv",		'-',			"-",	Expr.UNARY,	SUB.V	),
	POS:			Op("pos",		'+',			"+",	Expr.UNARY,	SUB.S	),
	POS_V:			Op("posv",		'+',			"+",	Expr.UNARY,	SUB.V	),
	NOT:			Op("not",		'~',			"~",	Expr.UNARY,	SUB.S	),
	NOT_V:			Op("notv",		'~',			"~",	Expr.UNARY,	SUB.V	),
	BNOT:			Op("bnot",		'!',			"!",	Expr.UNARY,	SUB.S	),
	BNOT_V:			Op("bnotv",		'!',			"!",	Expr.UNARY,	SUB.V	),
	
	KILL:			Op("kill",		DISCARD_SY,		0,		Expr.UNARY,	SUB.S	),
	
	PREDEC:			Op("predec",	MINUSMINUS_SY,	"--",	Expr.UNARY,	SUB.S	),
	PREINC:			Op("preinc",	PLUSPLUS_SY,	"++",	Expr.UNARY,	SUB.S	),
	POSTDEC:		Op("postdec",	MINUSMINUS_SY,	"--",	Expr.UNARY,	SUB.S	),
	POSTINC:		Op("postinc",	PLUSPLUS_SY,	"++",	Expr.UNARY,	SUB.S	),
	
	MEMBER_SELECTOR:Op("mselect",	'.',			".",	Expr.BINARY,	SUB.NONE),
	ARRAY_INDEX:	Op("index",		'[',			"[]",	Expr.BINARY,	SUB.NONE),
	FUN_CALL:		Op("call",		'(',			"()",	Expr.BINARY,	SUB.NONE),
	FUN_BUILTIN:	Op("builtin",	0,				0,		Expr.BINARY,	SUB.NONE),
	FUN_ARG:		Op("arg",		0,				0,		Expr.BINARY,	SUB.NONE),
	EXPR_LIST:		Op("list",		0,				0,		Expr.BINARY,	SUB.NONE),
	MUL:			Op("mul",		'*',			"*",	Expr.BINARY,	SUB.S	),
	MUL_V:			Op("mulv",		'*',			"*",	Expr.BINARY,	SUB.V	),
	MUL_SV:			Op("mulsv",		'*',			"*",	Expr.BINARY,	SUB.SV	),
	MUL_VS:			Op("mulvs",		'*',			"*",	Expr.BINARY,	SUB.VS	),
	DIV:			Op("div",		'/',			"/",	Expr.BINARY,	SUB.S	),
	DIV_V:			Op("divv",		'/',			"/",	Expr.BINARY,	SUB.V	),
	DIV_SV:			Op("divsv",		'/',			"/",	Expr.BINARY,	SUB.SV	),
	DIV_VS:			Op("divvs",		'/',			"/",	Expr.BINARY,	SUB.VS	),
	MOD:			Op("mod",		'%',			"%",	Expr.BINARY,	SUB.S	),
	MOD_V:			Op("modv",		'%',			"%",	Expr.BINARY,	SUB.V	),
	MOD_SV:			Op("modsv",		'%',			"%",	Expr.BINARY,	SUB.SV	),
	MOD_VS:			Op("modvs",		'%',			"%",	Expr.BINARY,	SUB.VS	),
	ADD:			Op("add",		'+',			"+",	Expr.BINARY,	SUB.S	),
	ADD_V:			Op("addv",		'+',			"+",	Expr.BINARY,	SUB.V	),
	ADD_SV:			Op("addsv",		'+',			"+",	Expr.BINARY,	SUB.SV	),
	ADD_VS:			Op("addvs",		'+',			"+",	Expr.BINARY,	SUB.VS	),
	SUB:			Op("sub",		'-',			"-",	Expr.BINARY,	SUB.S	),
	SUB_V:			Op("subv",		'-',			"-",	Expr.BINARY,	SUB.V	),
	SUB_SV:			Op("subsv",		'-',			"-",	Expr.BINARY,	SUB.SV	),
	SUB_VS:			Op("subvs",		'-',			"-",	Expr.BINARY,	SUB.VS	),
	SHL:			Op("shl",		LL_SY,			"<<",	Expr.BINARY,	SUB.S	),
	SHL_V:			Op("shlv",		LL_SY,			"<<",	Expr.BINARY,	SUB.V	),
	SHR:			Op("shr",		GG_SY,			">>",	Expr.BINARY,	SUB.S	),
	SHR_V:			Op("shrv",		GG_SY,			">>",	Expr.BINARY,	SUB.V	),
	LT:				Op("lt",		'<',			"<",	Expr.BINARY,	SUB.S	),
	LT_V:			Op("ltv",		'<',			"<",	Expr.BINARY,	SUB.V	),
	LT_SV:			Op("ltsv",		'<',			"<",	Expr.BINARY,	SUB.SV	),
	LT_VS:			Op("ltvs",		'<',			"<",	Expr.BINARY,	SUB.VS	),
	GT:				Op("gt",		'>',			">",	Expr.BINARY,	SUB.S	),
	GT_V:			Op("gtv",		'>',			">",	Expr.BINARY,	SUB.V	),
	GT_SV:			Op("gtsv",		'>',			">",	Expr.BINARY,	SUB.SV	),
	GT_VS:			Op("gtvs",		'>',			">",	Expr.BINARY,	SUB.VS	),
	LE:				Op("le",		LE_SY,			"<=",	Expr.BINARY,	SUB.S	),
	LE_V:			Op("lev",		LE_SY,			"<=",	Expr.BINARY,	SUB.V	),
	LE_SV:			Op("lesv",		LE_SY,			"<=",	Expr.BINARY,	SUB.SV	),
	LE_VS:			Op("levs",		LE_SY,			"<=",	Expr.BINARY,	SUB.VS	),
	GE:				Op("ge",		GE_SY,			">=",	Expr.BINARY,	SUB.S	),
	GE_V:			Op("gev",		GE_SY,			">=",	Expr.BINARY,	SUB.V	),
	GE_SV:			Op("gesv",		GE_SY,			">=",	Expr.BINARY,	SUB.SV	),
	GE_VS:			Op("gevs",		GE_SY,			">=",	Expr.BINARY,	SUB.VS	),
	EQ:				Op("eq",		EQ_SY,			"==",	Expr.BINARY,	SUB.S	),
	EQ_V:			Op("eqv",		EQ_SY,			"==",	Expr.BINARY,	SUB.V	),
	EQ_SV:			Op("eqsv",		EQ_SY,			"==",	Expr.BINARY,	SUB.SV	),
	EQ_VS:			Op("eqvs",		EQ_SY,			"==",	Expr.BINARY,	SUB.VS	),
	NE:				Op("ne",		NE_SY,			"!=",	Expr.BINARY,	SUB.S	),
	NE_V:			Op("nev",		NE_SY,			"!=",	Expr.BINARY,	SUB.V	),
	NE_SV:			Op("nesv",		NE_SY,			"!=",	Expr.BINARY,	SUB.SV	),
	NE_VS:			Op("nevs",		NE_SY,			"!=",	Expr.BINARY,	SUB.VS	),
	AND:			Op("and",		'&',			"&",	Expr.BINARY,	SUB.S	),
	AND_V:			Op("andv",		'&',			"&",	Expr.BINARY,	SUB.V	),
	AND_SV:			Op("andsv",		'&',			"&",	Expr.BINARY,	SUB.SV	),
	AND_VS:			Op("andvs",		'&',			"&",	Expr.BINARY,	SUB.VS	),
	XOR:			Op("xor",		'^',			"^",	Expr.BINARY,	SUB.S	),
	XOR_V:			Op("xorv",		'^',			"^",	Expr.BINARY,	SUB.V	),
	XOR_SV:			Op("xorsv",		'^',			"^",	Expr.BINARY,	SUB.SV	),
	XOR_VS:			Op("xorvs",		'^',			"^",	Expr.BINARY,	SUB.VS	),
	OR:				Op("or",		'|',			"|",	Expr.BINARY,	SUB.S	),
	OR_V:			Op("orv",		'|',			"|",	Expr.BINARY,	SUB.V	),
	OR_SV:			Op("orsv",		'|',			"|",	Expr.BINARY,	SUB.SV	),
	OR_VS:			Op("orvs",		'|',			"|",	Expr.BINARY,	SUB.VS	),
	BAND:			Op("band",		AND_SY,			"&&",	Expr.BINARY,	SUB.S	),
	BAND_V:			Op("bandv",		AND_SY,			"&&",	Expr.BINARY,	SUB.V	),
	BAND_SV:		Op("bandsv",	AND_SY,			"&&",	Expr.BINARY,	SUB.SV	),
	BAND_VS:		Op("bandvs",	AND_SY,			"&&",	Expr.BINARY,	SUB.VS	),
	BOR:			Op("bor",		OR_SY,			"||",	Expr.BINARY,	SUB.S	),
	BOR_V:			Op("borv",		OR_SY,			"||",	Expr.BINARY,	SUB.V	),
	BOR_SV:			Op("borsv",		OR_SY,			"||",	Expr.BINARY,	SUB.SV	),
	BOR_VS:			Op("borvs",		OR_SY,			"||",	Expr.BINARY,	SUB.VS	),
	ASSIGN:			Op("assign",	'=',			"=",	Expr.BINARY,	SUB.S	),
	ASSIGN_V:		Op("assignv",	'=',			"=",	Expr.BINARY,	SUB.V	),
	ASSIGN_GEN:		Op("assigngen",	'=',			"=",	Expr.BINARY,	SUB.NONE),
	ASSIGN_MASKED_KV:Op("assignm",	'=',			"=",	Expr.BINARY,	SUB.KV	),
	
	ASSIGNMINUS:	Op("assign-",	ASSIGNMINUS_SY,	"-=",	Expr.BINARY,	SUB.S	),
	ASSIGNMOD:		Op("assign%",	ASSIGNMOD_SY,	"%=",	Expr.BINARY,	SUB.S	),
	ASSIGNPLUS:		Op("assign+",	ASSIGNPLUS_SY,	"+=",	Expr.BINARY,	SUB.S	),
	ASSIGNSLASH:	Op("assign/",	ASSIGNSLASH_SY,	"/=",	Expr.BINARY,	SUB.S	),
	ASSIGNSTAR:		Op("assign*",	ASSIGNSTAR_SY,	"*=",	Expr.BINARY,	SUB.S	),
	ASSIGNAND:		Op("assign&",	ASSIGNAND_SY,	"&=",	Expr.BINARY,	SUB.S	),
	ASSIGNOR:		Op("assign|",	ASSIGNOR_SY,	"|=",	Expr.BINARY,	SUB.S	),
	ASSIGNXOR:		Op("assign^",	ASSIGNXOR_SY,	"^=",	Expr.BINARY,	SUB.S	),
	COMMA:			Op("comma",		',',			0,		Expr.BINARY,	SUB.NONE),
	
	COND:			Op("cond",		'?',			0,		Expr.TRINARY,	SUB.S	),
	COND_V:			Op("condv",		'?',			0,		Expr.TRINARY,	SUB.V	),
	COND_SV:		Op("condsv",	'?',			0,		Expr.TRINARY,	SUB.SV	),
	COND_GEN:		Op("condgen",	'?',			0,		Expr.TRINARY,	SUB.NONE),
	ASSIGN_COND:	Op("assc",		'@',			0,		Expr.TRINARY,	SUB.S	),
	ASSIGN_COND_V:	Op("asscv",		'@',			0,		Expr.TRINARY,	SUB.V	),
	ASSIGN_COND_SV:	Op("asscsc",	'@',			0,		Expr.TRINARY,	SUB.VS	),
	ASSIGN_COND_GEN:Op("asscgen",	'@',			0,		Expr.TRINARY,	SUB.NONE),
};
type opcode 	= keyof typeof OP;
type OpEntry	= typeof OP[keyof typeof OP];

class CG {
	hal 			= {} as any;

	error_count		= 0;
	warning_count	= 0;
	line_count		= 0;

	opts			= 0;

	// Scanner data:
	tokenLoc		= {} as TextPos;		// Source location of most recent token seen by the scanner
	lastSourceLoc	= {} as TextPos;
	errorLoc		= {} as TextPos;
	
	func_index		= 0;
	allow_semantic	= false;
	type_specs		= {} as Derived;
	
	current_scope	= new Scope;
	popped_scope?:	Scope;
	global_scope?:	Scope;
	super_scope?:	Scope;
	
	varyingIn?:		Sym;
	varyingOut?:	Sym;
	uniformParam:	Sym[] = [];
	uniformGlobal:	Sym[] = [];
	techniques:		Sym[] = [];
//	uniforms:	UniformSemantic;

//	constantBindings:	BindingList;
//	defaultBindings:	BindingList;
	atoms			= {} as Record<string, number>;

	constructor() {}

	Atom(s: string)				{ return this.atoms[s] ??= Object.values(this.atoms).length; }
	GetAtomString(a: number)	{ return Object.values(this.atoms)[a]; }

	SemanticWarning(code: string, ...params: any[]) {}
	SemanticError(code: string, ...params: any[]) {}
	SemanticParseError(code: string, ...params: any[]) {}
	InternalError(code: string, ...params: any[]) {}
	RecordErrorPos() {
		this.errorLoc = this.tokenLoc;
	}

	//scope
	PushScope(scope: Scope = new Scope) {
		this.current_scope?.push(scope);
		this.current_scope = scope;
	}
	PopScope(): Scope | undefined {
		const s = this.current_scope;
		if (s)
			this.current_scope = s.parent!;
		return this.popped_scope = s;
	}

	// Add a tag name to a scope.
	AddTag(tag: ident, category: number) {
		const sym	= new Sym(tag, Sym.TAG, new Type(category));
		this.current_scope.tags.push(sym);
		return sym;
	}
	AddSymbol(atom: ident, type: Type, kind: SymKind) {
		const sym = new Sym(atom, kind, type);
		this.current_scope.symbols.push(sym);
		return sym;
	}

	//dtype

	GetTypePointer(loc: TextPos, dtype: Derived) {
		if (dtype) {
			if (dtype.is_derived) {
				this.hal.CheckDeclarators(this, loc, dtype);
				const t			= duplicate(dtype.type);
				t.properties	&= ~(Type.MISC_TYPEDEF | Type.MISC_PACKED_KW);
				t.size			= this.hal.GetSizeof(t);
				return t;
			}
			return dtype.basetype;
		}
		return UndefinedType;
	}

	// Set a type's qualifier bits.  Issue an error if any bit is already set.
	SetTypeQualifiers(qualifiers: number) {
		qualifiers &= Type.QUALIFIER_MASK;
		const old = this.type_specs.type.properties & Type.QUALIFIER_MASK;
		if (old & qualifiers)
			this.SemanticWarning('WARNING___QUALIFIER_SPECIFIED_TWICE');
		if (old != qualifiers) {
			this.type_specs.type.properties |= qualifiers & Type.QUALIFIER_MASK;
			this.type_specs.is_derived = true;
			if ((this.type_specs.type.properties & (Type.QUALIFIER_CONST | Type.QUALIFIER_OUT)) == (Type.QUALIFIER_CONST | Type.QUALIFIER_OUT))
				this.SemanticError('ERROR___CONST_OUT_INVALID');
		}
	}

	// Set the domain of a type.  Issue an error if it's already set to a conflicting domain.
	SetTypeDomain(domain: number) {
		const old = this.type_specs.type.properties & Type.DOMAIN_MASK;
		if (old == Type.DOMAIN_UNKNOWN) {
			this.type_specs.type.SetDomain(domain);
			this.type_specs.is_derived = true;
		} else {
			if (old == domain)
				this.SemanticWarning('WARNING___DOMAIN_SPECIFIED_TWICE');
			else
				this.SemanticError('ERROR___CONFLICTING_DOMAIN');
		}
	}

	// Set a bit in the misc field a type.  Issue an error if it's already set.
	SetTypeMisc(misc: number) {
		if (this.type_specs.type.properties & (misc & ~Type.MISC_PACKED)) {
			this.SemanticError('ERROR___REPEATED_TYPE.ATTRIB');
		} else if (misc & ~Type.MISC_TYPEDEF) {
			this.type_specs.is_derived = true;
			this.type_specs.type.properties |= misc;
		}
	}

	ClearTypeMisc(misc: number) {
		this.type_specs.type.properties &= ~misc;
	}
	// Set the storage class of a type.  Issue an error if it's already set to a conflicting value.
	SetStorageClass(storage: SC) {
		if (this.type_specs.storage == SC.UNKNOWN)
			this.type_specs.storage = storage;
		else 
			this.SemanticError(this.type_specs.storage == storage ? 'ERROR___STORAGE_SPECIFIED_TWICE' : 'ERROR___CONFLICTING_STORAGE');
	}
	LookUpTypeSymbol(name: string) {
		const  sym = this.current_scope.LookUpSymbol(this.Atom(name));
		if (sym) {
			if (!sym.IsTypedef() && !sym.IsTemplate()) {
				this.InternalError('ERROR_S_NAME_NOT_A_TYPE', name);
				return UndefinedType;
			}
			return sym.type;
		} else {
			this.InternalError('ERROR_S_TYPE_NAME_NOT_FOUND', name);
			return UndefinedType;
		}
	}

	NewConstNode(op: opcode, val: number | number[] | string, base: number)			{ return Expr.NewConstNode(op, val, base); }
	NewBinaryOperator(op: opcode, left: Expr, right: Expr, integralOnly: boolean)	{ return Expr.NewBinopNode(op, left, right); }
	NewUnaryOperator(op: opcode, arg: Expr, integralOnly: boolean)					{ return Expr.NewUnopNode(op, arg); }
	NewCompoundAssignmentStmt(op: OpEntry, left: Expr, right: Expr) {
		const e = new Expr(op.name as opcode, op.kind, left.type);
		e.has_sideeffects	= true;
		e.binary			= {left, right};
		return this.NewExprStmt(e);
	}
	NewSimpleAssignmentStmt(left: Expr, right: Expr, subop = 0) {
		return this.NewExprStmt(Expr.NewBinopNode('ASSIGN', left, right, subop));
	}
	NewConditionalOperator(cond: Expr, thenExpr: Expr, elseExpr: Expr) {
		return Expr.NewTriopNode('COND', cond, thenExpr, elseExpr);
	}
	NewIndexOperator(array: Expr, index: Expr) {
		return Expr.NewBinopNode('ARRAY_INDEX', array, index);
	}
	NewFunctionCallOperator(func: Expr, args?: Expr) {
		return Expr.NewBinopNode('FUN_CALL', func, args);
	}
	NewCastOperator(expr: Expr, type: Type) {
		return Expr.NewUnopNode('CAST_CS', expr, type);
	}
	// The grammar's member/swizzle/write-mask distinctions all turn on the spelling of `member` (a single
	// `.x`, multi-char swizzle like `.xyz`, or an assignment target) -- that classification needs the atom
	// table this example stubs out, so this stays a typed placeholder rather than a real implementation.
	NewMemberSelectorOrSwizzleOrWriteMaskOperator(obj: Expr, member: ident) { return {} as Expr; }
	// Likewise: building the actual argument/parameter list for a constructor call needs real type-checking
	// against `type`'s element type, which this example doesn't model.
	NewConstructor(type: Type, args: Expr) { return {} as Expr; }

	NewExprStmt(expr: Expr) {
		const s = new Stmt(Stmt.EXPR, this.tokenLoc);
		s.expr_stmt = {exp: expr};
		return s;
	}
	NewIfStmt(cond: Expr, thenstmt?: Stmt, elsestmt?: Stmt) {
		const s = new Stmt(Stmt.IF, this.tokenLoc);
		s.if_stmt = {cond, thenstmt: thenstmt ?? new Stmt(Stmt.BLOCK, this.tokenLoc), elsestmt: elsestmt};
		return s;
	}
	NewWhileStmt(kind: KIND, cond: Expr, body: Stmt) {
		const s = new Stmt(kind, this.tokenLoc);
		s.while_stmt = {cond, body};
		return s;
	}
	NewForStmt(init: Stmt|undefined, cond: Expr, step: Stmt|undefined, body: Stmt) {
		const s = new Stmt(Stmt.FOR, this.tokenLoc);
		s.for_stmt = {init, cond, step, body};
		return s;
	}
	NewBlockStmt(body: Stmt[], scope?: Scope) {
		const s = new Stmt(Stmt.BLOCK, this.tokenLoc);
		s.block_stmt = {body, scope: scope!};
		return s;
	}
	NewReturnStmt(expr?: Expr) {
		const s = new Stmt(Stmt.RETURN, this.tokenLoc);
		if (expr)
			s.return_stmt = {exp: expr};
		return s;
	}
	NewDiscardStmt(cond: Expr) {
		const s = new Stmt(Stmt.DISCARD, this.tokenLoc);
		s.discard_stmt = {cond};
		return s;
	}
	NewBreakStmt() {
		return new Stmt(Stmt.BREAK, this.tokenLoc);
	}
	NewSwitchStmt(cond: Expr, cases: Stmt[], scope: Scope) {
		const s = new Stmt(Stmt.SWITCH, this.tokenLoc);
		s.switch_stmt = {cond, cases, scope};
		return s;
	}

	NewDeclNode(name: ident, dtype?: Derived) {
		const d = new Decl(name, Expr.DECL);
		if (dtype)
			d.type = dtype;
		return d;
	}

	EnumHeader(tag?: ident) {
		if (!tag)
			return new Type(Type.CATEGORY_ENUM);

		let sym = this.current_scope.LookUpTag(tag);
		if (!sym) {
			sym				= this.AddTag(tag, Type.CATEGORY_ENUM);
			sym.type.enm	= {tag, members: new Scope};
		} else if (!sym.type.IsCategory(Type.CATEGORY_ENUM)) {
			this.SemanticError('ERROR_S_TAG_IS_NOT_A_STRUCT', this.GetAtomString(tag));
			return UndefinedType;
		}
		return sym.type;
	}
	EnumAdd(name: ident, value: number) {
		const sym = this.AddSymbol(name, this.type_specs.basetype, Sym.CONSTANT);
		sym.con = {value};
		return sym;
	}

	StructHeader(semantics?: ident, tag?: ident) { return {} as Type; }
	TemplateHeader(tag: ident, params: Decl[]) { return {} as Type; }
	ConstantBuffer(tag: ident, register?: ident) { return {} as Sym; }
	DefineTechnique(name: ident, passes: Expr[], annotation?: Stmt) { return 0; }
	FunctionDeclHeader(declOrLoc: Decl | TextPos | undefined, decl?: Decl) { return {} as Decl; }

	GetFloatSuffixBase(suffix: string) {
		switch (suffix) {
		case 'f':
		case 'F':
			return Type.BASE_FLOAT;
		case 'l':
		case 'L':
		default:
			return Type.BASE_FLOAT;
		}
	}
	CheckBooleanExpr(expr: Expr, len?: number) { return {result: {} as Expr, len: 0}; }
	GlobalInitStatements(stmt: Stmt) { return 0; }
	ParseAsm() { return {} as Stmt; }
	GetOperatorName(op: OpEntry) { return 0; }
	Array_Declarator(decl: Decl, size: number, flag: number) { return {} as Decl; }
	BasicVariable(name: ident) { return {} as Expr; }
	ArgumentList(list?: Expr, arg?: Expr) { return {} as Expr; }
	GetConstant(expr: Expr, flag: number) { return 0; }
	IntToType(value: number) { return {} as Type; }
	DefineFunction(decl: Decl, body?: Stmt[]) { return 0; }
	SetStructMembers(type: Type, scope?: Scope) { return {} as Type; }
	AddtoTypeList(list: Type[], item: Type) { return [] as Type[]; }
	SymbolicConstant(name?: ident, value?: ident) { return {} as Expr; }
	StateInitializer(name: ident | string, value: Expr | Expr[]) { return {} as Expr; }
	Initializer(value: Expr | Expr[]) { return {} as Expr; }
	Param_Init_Declarator(decl: Decl, init?: Expr) { return {} as Decl; }
	Init_Declarator(decl: Decl, init?: Expr) { return {} as Stmt; }
	SetFunTypeParams(decl: Decl, params: Decl[], variadic: Decl[]) { return {} as Decl; }
	Declarator(basic: Decl, semantics?: ident, register?: ident) { return {} as Decl; }
	Function_Definition_Header(decl: Decl) { return {} as Decl; }

	SetConstantBuffer(sym: Sym, members: Scope) { return {} as Expr; }
};


//dummy functions
function SUBOP_V(..._: any) { return 0; }

const error = terminal('error');
const UndefinedType = new Type(0);

/****************/
/* Grammar */
/****************/

// forward declare
const declaration 						= Forward<Stmt>(()=>_declaration);
const abstract_declaration 				= Forward<Decl>(()=>_abstract_declaration);
const declaration_specifiers 			= Forward<Expr>(()=>_declaration_specifiers);
const abstract_declaration_specifiers 	= Forward<Derived>(()=>_abstract_declaration_specifiers);
const declarator 						= Forward<Decl>(()=>_declarator);
const basic_declarator 					= Forward<Decl>(()=>_basic_declarator);
const type_specifier 					= Forward<Type>(()=>_type_specifier);
const constant_expression 				= Forward<number>(()=>_constant_expression);
const expression 						= Forward<Expr>(()=>_expression);
const initializer 						= Forward<Expr>(()=>_initializer);
const block_item_list 					= Forward<Stmt[]>(()=>_block_item_list);
const statement 						= Forward<Stmt>(()=>_statement);

const UINTCONST_SY	= Rules(
	Rule([/\d+/], $ => parseInt($[0]))
);

const INTCONST_SY	= Rules(
	Rule([UINTCONST_SY]),
	Rule(['-', UINTCONST_SY], $ => -$[1])
);

const CFLOATCONST_SY = Rules(
	Rule([/[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?/],	$ => parseFloat($[0]))
);

const identifier = Rules<ident>(
	Rule([IDENT_SY] as const, () => 0),
);

const struct_identifier = Rules<ident>(
	Rule([identifier]),
	Rule([TYPEIDENT_SY] as const, () => 0),
);

const enum_header = Rules(
	Rule([ENUM_SY, struct_identifier] as const, ($, cg) => cg.EnumHeader($[1])),
);

const enum_declaration = Rules(
	Rule([identifier] as const, ($, cg) => { cg.EnumAdd($[0], 0); }),
	Rule([identifier, '=', INTCONST_SY] as const, ($, cg) => { cg.EnumAdd($[0], $[2]); }),
);

const enum_declaration_list = Rules(self => [
	Rule([enum_declaration]),
	Rule([self, ',', enum_declaration] as const),
]);

const untagged_enum_header = Rules(
	Rule([ENUM_SY] as const, ($, cg) => cg.EnumHeader(0)),
);
/****************/
/* Enum Types */
/****************/

const enum_specifier = Rules(
	Rule([enum_header, '{', ($: any, cg: CG) => {cg.type_specs.SetDType($[0]);}, enum_declaration_list, '}'] as const),
	Rule([untagged_enum_header, '{', ($: any, cg: CG) => {cg.type_specs.SetDType($[0]);}, enum_declaration_list, '}'] as const),
	Rule([enum_header]),
);

const semantics_identifier = Rules<ident>(
	Rule([identifier]),
);

const struct_or_connector_header = Rules(
	Rule([STRUCT_SY, struct_identifier] as const, ($, cg) => cg.StructHeader(0, $[1])),
	Rule([STRUCT_SY, struct_identifier, ':', semantics_identifier] as const, ($, cg) => cg.StructHeader($[3], $[1])),
	Rule([STRUCT_SY, struct_identifier, ':', TYPEIDENT_SY] as const, ($, cg) => cg.StructHeader(0, $[1]).AddStructBase(cg.LookUpTypeSymbol($[3]))),
);

const compound_header = Rules(
	Rule(['{'] as const, ($, cg) => { cg.PushScope(); cg.current_scope!.funindex = cg.func_index; }),
);

const struct_compound_header = Rules(
	Rule([compound_header] as const, ($, cg) => { cg.current_scope!.flags |= Scope.is_struct; return $[0]; }),
);

/***************/
/* Attributes */
/***************/

const attribute = Rules(
	Rule(['[', identifier, ']'] as const, 																$ => new Attr($[1])),
	Rule(['[', identifier, '(', INTCONST_SY, ')', ']'] as const, 										$ => new Attr($[1], $[3])),
	Rule(['[', identifier, '(', INTCONST_SY, ',', INTCONST_SY, ')', ']'] as const, 						$ => new Attr($[1], $[3], $[5])),
	Rule(['[', identifier, '(', INTCONST_SY, ',', INTCONST_SY, ',', INTCONST_SY, ')', ']'] as const, 	$ => new Attr($[1], $[3], $[5], $[7])),
);

const variable_identifier = Rules(
	Rule([identifier]),
);

const basic_variable = Rules(
	Rule([variable_identifier] as const, ($, cg) => cg.BasicVariable($[0])),
);

const scope_identifier = Rules(
	Rule([identifier]),
);
/************/
/* Variable */
/************/

const variable = Rules(
	Rule([basic_variable]),
	Rule([scope_identifier, COLONCOLON_SY, basic_variable] as const, $ => $[2]),
);

const constant = Rules(
	Rule([INTCONST_SY, /*, Temporary!, */] as const, 	($, cg) => cg.NewConstNode('ICONST', $[0], Type.BASE_CINT)),
	Rule([UINTCONST_SY, /*, Temporary!, */] as const, 	($, cg) => cg.NewConstNode('ICONST', $[0], Type.BASE_CINT)),
	Rule([CFLOATCONST_SY, /*, Temporary!, */] as const, ($, cg) => cg.NewConstNode('FCONST', $[0], cg.GetFloatSuffixBase(' '))),
	Rule([CFLOATCONST_SY, /[fF]/] as const, 			($, cg) => cg.NewConstNode('FCONST', $[0], cg.GetFloatSuffixBase('f'))),
	Rule([CFLOATCONST_SY, /[hH]/] as const,				($, cg) => cg.NewConstNode('FCONST', $[0], cg.GetFloatSuffixBase('h'))),
	Rule([CFLOATCONST_SY, /[xX]/] as const,				($, cg) => cg.NewConstNode('FCONST', $[0], cg.GetFloatSuffixBase('x'))),
	Rule([STRCONST_SY, /*, Temporary!, */] as const,	($, cg) => cg.NewConstNode('ICONST', $[0], Type.BASE_STRING)),
);

const expression_list = Rules<Expr>(self => [
	Rule([expression] as const, $ => $[0]),
	Rule([self, ',', expression] as const, $ => Expr.NewBinopNode('EXPR_LIST', $[0], $[2])),
]);

/**********************/
/* Primary Expression */
/**********************/

const primary_expression = Rules(
	Rule([variable]),
	Rule([constant]),
	Rule(['(', expression, ')'] as const, 						$ => $[1]),
	Rule([type_specifier, '(', expression_list, ')'] as const,	($, cg) => cg.NewConstructor($[0], $[2])),
);

/*********/
/* Misc. */
/*********/

const member_identifier = Rules(
	Rule([identifier]),
);

const actual_argument_list = Rules(
	Rule([/*, empty, */], () => undefined),
	Rule([expression_list]),
);

/*********************/
/* Postfix Operators */
/*********************/

const postfix_expression = Rules<Expr>(self => [
	Rule([primary_expression]),
	Rule([self, PLUSPLUS_SY] as const, 						$ => Expr.NewUnopNode('POSTINC', $[0])),
	Rule([self, MINUSMINUS_SY] as const, 					$ => Expr.NewUnopNode('POSTDEC', $[0])),
	Rule([self, '.', member_identifier] as const, 			($, cg) => cg.NewMemberSelectorOrSwizzleOrWriteMaskOperator($[0], $[2])),
	Rule([self, '[', expression, ']'] as const, 			($, cg) => cg.NewIndexOperator($[0], $[2])),
	Rule([self, '(', actual_argument_list, ')'] as const, 	($, cg) => cg.NewFunctionCallOperator($[0], $[2])),
]);

/*******************/
/* Unary Operators */
/*******************/

const unary_expression = Rules<Expr>(self => [
	Rule([postfix_expression]),
	Rule([PLUSPLUS_SY, self] as const,		$ => Expr.NewUnopNode('PREINC', $[1])),
	Rule([MINUSMINUS_SY, self] as const,	$ => Expr.NewUnopNode('PREDEC', $[1])),
	Rule(['+', self] as const, 				($, cg) => cg.NewUnaryOperator('POS', $[1], false)),
	Rule(['-', self] as const, 				($, cg) => cg.NewUnaryOperator('NEG', $[1], false)),
	Rule(['!', self] as const, 				($, cg) => cg.NewUnaryOperator('BNOT',$[1], false)),
	Rule(['~', self] as const, 				($, cg) => cg.NewUnaryOperator('NOT', $[1], true)),
]);				

const non_empty_abstract_parameter_list = Rules<Decl[]>(self => [
	Rule([abstract_declaration] as const, ($, cg) => {
		if ($[0].type!.type.IsVoid())
			cg.current_scope!.flags |= Scope.has_void_param;
		return [$[0]];
	}),
	Rule([self, ',', abstract_declaration] as const, ($, cg) => {
		if ((cg.current_scope!.flags & Scope.has_void_param) || $[0][0].type!.type.IsVoid())
			cg.SemanticError('ERROR___VOIDOT_ONLY_PARAM');
		return [...$[0], $[2]];
	}),
]);

const abstract_parameter_list = Rules<Decl[]>(
	Rule([/*, empty, */] as const, () => []),
	Rule([non_empty_abstract_parameter_list]),
);

const abstract_declarator = Rules<Decl>(self => [
	Rule([/*, empty, */] as const, ($, cg) => cg.NewDeclNode(0, cg.type_specs)),
	Rule([self, '[', constant_expression, ']'] as const, ($, cg) => cg.Array_Declarator($[0], $[2], 0)),
	Rule([self, '[', ']'] as const, ($, cg) => cg.Array_Declarator($[0], 0 , 1)),
/***
 *** This rule causes a major shift reduce conflict with:
 ***
 ***	primary_expression	:;=	type_specifier '(' expression_list ')'
 ***
 *** Cannot be easily factored.	Would force: "( expr -list )" to be merged with "( abstract-param-list )"
 ***
 *** Matches other shading languages' syntax.
 *** Will disallow abstract literal function parameter declarations should we ever defide to
 ***	support function parameters in the future.
 ***
	Rule([abstract_declarator, '(', abstract_parameter_list, ')'] as const),
***/
]);

const _abstract_declaration = Rules(
	Rule([abstract_declaration_specifiers, abstract_declarator] as const, $ => $[1]),
);

/*****************/
/* Expression */
/*****************/

const cast_expression = Rules<Expr>(self => [
	Rule([unary_expression]),
/* *** reduce/reduce conflict: (var-ident) (type-ident) ***
	Rule(['(', type_name, ')', cast_expression] as const),
*/
	Rule(['(', abstract_declaration, ')', self] as const, ($, cg) => cg.NewCastOperator($[3], cg.GetTypePointer($[1].loc!, $[1].type!))),
]);

const multiplicative_expression = Rules<Expr>(self => [
	Rule([cast_expression]),
	Rule([self, '*', cast_expression] as const, ($, cg) => cg.NewBinaryOperator('MUL', $[0], $[2], false)),
	Rule([self, '/', cast_expression] as const, ($, cg) => cg.NewBinaryOperator('DIV', $[0], $[2], false)),
	Rule([self, '%', cast_expression] as const, ($, cg) => cg.NewBinaryOperator('MOD', $[0], $[2], true)),
]);

const additive_expression = Rules<Expr>(self => [
	Rule([multiplicative_expression]),
	Rule([self, '+', multiplicative_expression] as const, ($, cg) => cg.NewBinaryOperator('ADD', $[0], $[2], false)),
	Rule([self, '-', multiplicative_expression] as const, ($, cg) => cg.NewBinaryOperator('SUB', $[0], $[2], false)),
]);

const shift_expression = Rules<Expr>(self => [
	Rule([additive_expression]),
	Rule([self, LL_SY, additive_expression] as const, ($, cg) => cg.NewBinaryOperator('SHL', $[0], $[2], true)),
	Rule([self, GG_SY, additive_expression] as const, ($, cg) => cg.NewBinaryOperator('SHR', $[0], $[2], true)),
]);

const relational_expression = Rules<Expr>(self => [
	Rule([shift_expression]),
	Rule([self, '<', shift_expression] as const, 	($, cg) => cg.NewBinaryOperator('LT', $[0], $[2], false)),
	Rule([self, '>', shift_expression] as const, 	($, cg) => cg.NewBinaryOperator('GT', $[0], $[2], false)),
	Rule([self, LE_SY, shift_expression] as const,	($, cg) => cg.NewBinaryOperator('LE', $[0], $[2], false)),
	Rule([self, GE_SY, shift_expression] as const,	($, cg) => cg.NewBinaryOperator('GE', $[0], $[2], false)),
]);

const equality_expression = Rules<Expr>(self => [
	Rule([relational_expression]),
	Rule([self, EQ_SY, relational_expression] as const, ($, cg) => cg.NewBinaryOperator('EQ', $[0], $[2], false)),
	Rule([self, NE_SY, relational_expression] as const, ($, cg) => cg.NewBinaryOperator('NE', $[0], $[2], false)),
]);

const AND_expression = Rules<Expr>(self => [
	Rule([equality_expression]),
	Rule([self, '&', equality_expression] as const, ($, cg) => cg.NewBinaryOperator('AND', $[0], $[2], true)),
]);

const exclusive_OR_expression = Rules<Expr>(self => [
	Rule([AND_expression]),
	Rule([self, '^', AND_expression] as const, ($, cg) => cg.NewBinaryOperator('XOR', $[0], $[2], true)),
]);

const inclusive_OR_expression = Rules<Expr>(self => [
	Rule([exclusive_OR_expression]),
	Rule([self, '|', exclusive_OR_expression] as const, ($, cg) => cg.NewBinaryOperator('OR', $[0], $[2], true)),
]);

const logical_AND_expression = Rules<Expr>(self => [
	Rule([inclusive_OR_expression]),
	Rule([self, AND_SY, inclusive_OR_expression] as const, ($, cg) => cg.NewBinaryOperator('BAND', $[0], $[2], true)),
]);

const logical_OR_expression = Rules<Expr>(self => [
	Rule([logical_AND_expression]),
	Rule([self, OR_SY, logical_AND_expression] as const, ($, cg) => cg.NewBinaryOperator('BOR', $[0], $[2], true)),
]);

const conditional_test = Rules<any>(
	Rule([logical_OR_expression] as const, ($, cg) => cg.CheckBooleanExpr($[0]).result),
);

const conditional_expression = Rules<Expr>(self => [
	Rule([logical_OR_expression]),
	Rule([conditional_test, '?', expression, ':', self] as const, ($, cg) => cg.NewConditionalOperator($[0], $[2], $[4])),
]);

const _expression = Rules(
	Rule([conditional_expression]),
/***
	Rule([basic_variable, '=', expression] as const, ($, cg) => cg.NewBinopNode(OP.ASSIGN, $[0], $[2])),
***/
);

const _constant_expression = Rules(
	Rule([expression] as const, ($, cg) => cg.GetConstant($[0], 0)),
);

const operator = Rules(
	Rule(['+'		] as const, () => 'POS'),
	Rule(['-', 		] as const, () => 'NEG'),
	Rule(['!', 		] as const, () => 'BNOT'),
	Rule(['~', 		] as const, () => 'NOT'),
	Rule(['*', 		] as const, () => 'MUL'),
	Rule(['/', 		] as const, () => 'DIV'),
	Rule(['%'		] as const, () => 'MOD'),
	Rule([GG_SY, 	] as const, () => 'SHR'),
	Rule(['<', 		] as const, () => 'LT'),
	Rule(['>', 		] as const, () => 'GT'),
	Rule([LE_SY, 	] as const, () => 'LE'),
	Rule([GE_SY, 	] as const, () => 'GE'),
	Rule([EQ_SY, 	] as const, () => 'EQ'),
	Rule([NE_SY		] as const, () => 'NE'),
	Rule(['&', 		] as const, () => 'AND'),
	Rule(['^', 		] as const, () => 'XOR'),
	Rule(['|', 		] as const, () => 'OR'),
	Rule([AND_SY, 	] as const, () => 'BAND'),
	Rule([OR_SY		] as const, () => 'BOR'),
	Rule(['(', ')'	] as const, () => 'FUN_CALL'),
	Rule(['[', ']'	] as const, () => 'ARRAY_INDEX'),
);

const initializer_list = List(initializer, ',');

const state_value = Rules(
	Rule([identifier] as const, ($, cg) => cg.SymbolicConstant($[0], 0)),
	Rule([constant]),
	Rule(['<', additive_expression, '>'] as const, $ => $[1]),
);

const state = Rules(
	Rule([identifier, '=', state_value] as const, 	($, cg) => cg.StateInitializer($[0], $[2])),
	Rule([TYPEIDENT_SY, '=', state_value] as const, ($, cg) => cg.StateInitializer($[0], $[2])),
);

const state_list = Rules<Expr>(self => [
	Rule([state, ';'] as const),
	Rule([self, state, ';'] as const, $ => Expr.NewBinopNode('EXPR_LIST', $[0], $[1]))
]);

/******************/
/* Initialization */
/******************/

const _initializer = Rules<any>(
	Rule([expression] as const, 							($, cg) => cg.Initializer($[0])),
	Rule(['{', initializer_list, '}'] as const,				($, cg) => cg.Initializer($[1])),
	Rule(['{', initializer_list, ',', '}'] as const,		($, cg) => cg.Initializer($[1])),
	Rule([SAMPLERSTATE_SY, '{', state_list, '}'] as const,	$ => $[2]),
);

const parameter_declaration = Rules<Decl>(self => [
	Rule([attribute, self] as const, $ => $[1].AddAttribute($[0])),
	Rule([declaration_specifiers, declarator] as const, ($, cg) => cg.Param_Init_Declarator($[1])),
	Rule([declaration_specifiers, declarator, '=', initializer] as const, ($, cg) => cg.Param_Init_Declarator($[1], $[3])),
]);

const compound_tail = Rules(
	Rule(['}'] as const, ($, cg) => cg.PopScope())
);
/************************/
/* Stetements */
/************************/

const expression_statement = Rules(
	Rule([expression] as const,										($, cg) => cg.NewExprStmt($[0])),
	Rule([postfix_expression, '=', expression] as const,			($, cg) => cg.NewSimpleAssignmentStmt($[0], $[2], 0)),
	Rule([postfix_expression, ASSIGNMINUS_SY, expression] as const, ($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNMINUS, $[0], $[2])),
	Rule([postfix_expression, ASSIGNMOD_SY, expression] as const, 	($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNMOD, $[0], $[2])),
	Rule([postfix_expression, ASSIGNPLUS_SY, expression] as const, 	($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNPLUS, $[0], $[2])),
	Rule([postfix_expression, ASSIGNSLASH_SY, expression] as const, ($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNSLASH, $[0], $[2])),
	Rule([postfix_expression, ASSIGNSTAR_SY, expression] as const, 	($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNSTAR, $[0], $[2])),
	Rule([postfix_expression, ASSIGNAND_SY, expression] as const, 	($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNAND, $[0], $[2])),
	Rule([postfix_expression, ASSIGNOR_SY, expression] as const, 	($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNOR, $[0], $[2])),
	Rule([postfix_expression, ASSIGNXOR_SY, expression] as const, 	($, cg) => cg.NewCompoundAssignmentStmt(OP.ASSIGNXOR, $[0], $[2])),
);

const boolean_scalar_expression = Rules(
	Rule([expression] as const, ($, cg) => cg.CheckBooleanExpr($[0]).result)
);

const init_declarator = Rules(
	Rule([declarator] as const, ($, cg) => cg.Init_Declarator($[0])),
	Rule([declarator, '=', initializer] as const, ($, cg) => cg.Init_Declarator($[0], $[2])),
);

const init_declarator_list = List(init_declarator, ',');

const for_expression_opt = Rules<Stmt|undefined>(
	Rule([List(expression_statement, ',')], ($, cg) => cg.NewBlockStmt($[0])),
	Rule([/*, empty, */], () => undefined),
);

const for_expression_init = Rules<Stmt|undefined>(
	Rule([declaration_specifiers, init_declarator_list] as const, ($, cg) => cg.NewBlockStmt($[1])),
	Rule([for_expression_opt]),
);

const boolean_expression_opt = Rules(
	Rule([boolean_scalar_expression]),
	Rule([/*, empty, */] as const, () => ({} as Expr)),
);

const if_header = Rules(
	Rule([IF_SY, '(', boolean_scalar_expression, ')'] as const, ($, cg) => cg.NewIfStmt($[2]) ),
);

const labeled_statement = Rules(
	Rule([CASE_SY, constant_expression, ':', statement] as const, $ => $[3]),
	Rule([DEFAULT_SY, ':', statement] as const, $ => $[2]),
);

const assembly = Rules(
	Rule([], ($, cg) => cg.ParseAsm())
);

const balanced_statement = Rules<Stmt>(self => [
	Rule([compound_header, block_item_list, compound_tail] as const, ($, cg) => cg.NewBlockStmt($[1], cg.popped_scope)),
	Rule([compound_header, compound_tail] as const, () => ({} as Stmt)),

	Rule([DISCARD_SY, ';'] as const, ($, cg) => cg.NewDiscardStmt(new Expr('KILL', Expr.UNARY))),
	Rule([DISCARD_SY, expression, ';'] as const, ($, cg) => {
		const {result, len} = cg.CheckBooleanExpr($[1]);
		return cg.NewDiscardStmt(Expr.NewUnopNode('KILL', result, undefined, SUBOP_V(len, Type.BASE_BOOLEAN)));
	}),

	Rule([expression_statement, ';'] as const),
	Rule([';'] as const, () => ({} as Stmt)),

	Rule([WHILE_SY, '(', boolean_scalar_expression, ')', self] as const, 						($, cg) => cg.NewWhileStmt(Stmt.WHILE, $[2], $[4])),
	Rule([DO_SY, statement, WHILE_SY, '(', boolean_scalar_expression, ')', ';'] as const, 		($, cg) => cg.NewWhileStmt(Stmt.DO, $[4], $[1])),
	Rule([FOR_SY, '(', for_expression_init, ';', boolean_expression_opt, ';', for_expression_opt, ')', self] as const, ($, cg) => cg.NewForStmt($[2], $[4], $[6], $[8])),

	Rule([if_header, self, ELSE_SY, self] as const, $ => $[0].SetThenElseStmts($[1], $[3])),

	Rule([SWITCH_SY, '(', expression, ')', compound_header, List(labeled_statement), compound_tail] as const, ($, cg) => cg.NewSwitchStmt($[2], $[5], cg.popped_scope!)),
	Rule([BREAK_SY, ';'] as const, ($, cg) => cg.NewBreakStmt()),
	Rule([RETURN_SY, expression, ';'] as const, ($, cg) => cg.NewReturnStmt($[1])),
	Rule([RETURN_SY, ';'] as const, ($, cg) => cg.NewReturnStmt()),

	Rule([ASM_SY, '{', assembly, '}'] as const, $ => $[2]),
]);

const dangling_statement = Rules<Stmt>(self => [
//	dangling_if
	Rule([if_header, statement] as const, $ => $[0].SetThenElseStmts($[1])),
	Rule([if_header, balanced_statement, ELSE_SY, self] as const, $ => $[0].SetThenElseStmts($[1], $[3])),
//	dangling_iteration
	Rule([WHILE_SY, '(', boolean_scalar_expression, ')', self] as const, ($, cg) => cg.NewWhileStmt(Stmt.WHILE, $[2], $[4])),
	Rule([FOR_SY, '(', for_expression_init, ';', boolean_expression_opt, ';', for_expression_opt, ')', self] as const, ($, cg) => cg.NewForStmt($[2], $[4], $[6], $[8])),
]);

const _statement = Rules<Stmt>(self => [
	Rule([attribute, self] as const, $ => $[1].AddAttribute($[0])),
	Rule([balanced_statement]),
	Rule([dangling_statement]),
]);

const block_item = Rules(
	Rule([declaration]),
	Rule([statement] as const, $ => $[0].Check()),
);

const _block_item_list = List(block_item);

const function_decl_header = Rules<Decl>(
	Rule([basic_declarator, '('] as const, ($, cg) => cg.FunctionDeclHeader($[0].loc, $[0])),
	Rule([OPERATOR_SY, operator, '('] as const, ($, cg) => cg.FunctionDeclHeader(cg.NewDeclNode(cg.Atom($[1]), cg.type_specs))),
);

const _basic_declarator = Rules<Decl>(self => [
	Rule([identifier] as const, ($, cg) => cg.NewDeclNode($[0], cg.type_specs)),
	Rule([self, '[', constant_expression, ']'] as const, ($, cg) => cg.Array_Declarator($[0], $[2], 0)),
	Rule([self, '[', ']'] as const, ($, cg) => cg.Array_Declarator($[0], 0, 1)),
	Rule([function_decl_header, List(parameter_declaration, ','), ')'] as const, ($, cg) => cg.SetFunTypeParams($[0], $[1], $[1])),
	Rule([function_decl_header, abstract_parameter_list, ')'] as const, ($, cg) => cg.SetFunTypeParams($[0], $[1], [])),
]);

const register_spec = Rules<ident>(
	Rule([REGISTER_SY, '(', identifier, ')'] as const, $ => $[2]),
	Rule([REGISTER_SY, '(', identifier, ',', identifier, ')'] as const, $ => $[4]),
);

const semantic_declarator = Rules<Decl>(
	Rule([basic_declarator] as const, ($, cg) => cg.Declarator($[0], 0, 0)),
	Rule([basic_declarator, ':', semantics_identifier] as const, ($, cg) => cg.Declarator($[0], $[2], 0)),
	Rule([basic_declarator, ':', register_spec] as const, ($, cg) => cg.Declarator($[0], 0, $[2])),
	Rule([basic_declarator, ':', semantics_identifier, ':', register_spec] as const, ($, cg) => cg.Declarator($[0], $[2], $[4])),
);

/***************/
/* Annotations */
/***************/

const annotation_decl_list = Rules<Stmt>(self => [
	Rule([/*, empty, */] as const, () => ({} as Stmt)),
	Rule([self, declaration] as const),
]);

const annotation = Rules(
	Rule(['<', ($, cg) => { cg.PushScope(); }, annotation_decl_list, '>'] as const, ($, cg) => { cg.PopScope(); return $[2]; }),
);

/***************/
/* Declarators */
/***************/

const _declarator = Rules<Decl>(
	Rule([semantic_declarator]),
	Rule([semantic_declarator, annotation] as const),
);

const function_definition_header = Rules<Decl>(self => [
	Rule([attribute, self] as const, $ => $[1].AddAttribute($[0])),
	Rule([declaration_specifiers, declarator, '{'] as const, ($, cg) => cg.Function_Definition_Header($[1])),
]);

/***********************/
/* Function Definition */
/***********************/

const function_definition = Rules(
	Rule([function_definition_header, block_item_list, '}'] as const, ($, cg) => { cg.DefineFunction($[0], $[1]); cg.PopScope(); }),
	Rule([function_definition_header, '}'] as const, ($, cg) => { cg.DefineFunction($[0]); cg.PopScope(); }),
);

/****************/
/* Struct Types */
/****************/

const struct_declaration = Rules<any>(
	Rule([declaration]),
	Rule([function_definition]),
);

const struct_declaration_list = Rules(self => [
	Rule([struct_declaration]),
	Rule([self, struct_declaration]),
]);


const struct_or_connector_specifier = Rules(
	Rule([struct_or_connector_header, struct_compound_header, struct_declaration_list, '}'] as const, ($, cg) => cg.SetStructMembers($[0], cg.PopScope())),
	Rule([STRUCT_SY, struct_compound_header, struct_declaration_list, '}'] as const, ($, cg) => cg.SetStructMembers(cg.StructHeader(0, 0), cg.PopScope())),
	Rule([struct_or_connector_header]),
);

/****************/
/* Templated Types */
/****************/

const template_arg = Rules(
	Rule([type_specifier]),
	Rule([additive_expression] as const, ($, cg) => cg.IntToType(cg.GetConstant($[0], 0))),
);

const non_empty_template_arg_list = Rules<Type[]>(self => [
	Rule([template_arg] as const, ($, cg) => cg.AddtoTypeList([], $[0])),
	Rule([self, ',', template_arg] as const, ($, cg) => cg.AddtoTypeList($[0], $[2])),
]);
const template_arg_list = Rules<Type[]>(
	Rule([/*, empty, */] as const, () => []),
	Rule([non_empty_template_arg_list]),
);

const templated_type = Rules(
	Rule([TEMPLATEIDENT_SY] as const, ($, cg) => cg.LookUpTypeSymbol($[0]).InstantiateTemplate([])),
	Rule([TEMPLATEIDENT_SY, '<', template_arg_list, '>'] as const, ($, cg) => cg.LookUpTypeSymbol($[0]).InstantiateTemplate($[2])),
);


/*******************/
/* Type Specifiers */
/*******************/

const _type_specifier = Rules(
	Rule([INT_SY] as const, 				($, cg) => cg.LookUpTypeSymbol(INT_SY)),
	Rule([UNSIGNED_SY, INT_SY] as const, 	($, cg) => cg.LookUpTypeSymbol(INT_SY)),
	Rule([FLOAT_SY] as const, 				($, cg) => cg.LookUpTypeSymbol(FLOAT_SY)),
	Rule([VOID_SY] as const, 				($, cg) => cg.LookUpTypeSymbol(VOID_SY)),
	Rule([BOOLEAN_SY] as const, 			($, cg) => cg.LookUpTypeSymbol(BOOLEAN_SY)),
	Rule([TEXOBJ_SY] as const, 				($, cg) => cg.LookUpTypeSymbol(TEXOBJ_SY)),
	Rule([enum_specifier]),
	Rule([struct_or_connector_specifier]),
	Rule([TYPEIDENT_SY] as const, 			($, cg) => cg.LookUpTypeSymbol($[0])),
	Rule([templated_type]),
	Rule([error] as const, 					($, cg) => {cg.SemanticParseError('ERROR_S_TYPE.NAME_EXPECTED'); return UndefinedType; })
);

/*******************/
/* Type Qualifiers */
/*******************/

const type_qualifier = Rules<number>(
	Rule([CONST_SY] as const, () => Type.QUALIFIER_CONST),
);

/*******************/
/* Storage Classes */
/*******************/

const storage_class = Rules<number>(
	Rule([STATIC_SY] as const, () => SC.STATIC),
	Rule([EXTERN_SY] as const, () => SC.EXTERN),
	Rule([NOINTERP_SY] as const, () => SC.NOINTERP),
	Rule([PRECISE_SY] as const, () => SC.PRECISE),
	Rule([SHARED_SY] as const, () => SC.SHARED),
	Rule([GROUPSHARED_SY] as const, () => SC.GROUPSHARED),
	Rule([VOLATILE_SY] as const, () => SC.UNKNOWN),
);

/****************/
/* Type Domains */
/****************/

const type_domain = Rules<number>(
	Rule([UNIFORM_SY] as const, () => Type.DOMAIN_UNIFORM),
);

/**********/
/* In Out */
/**********/

const in_out = Rules<number>(
	Rule([IN_SY] as const, () => Type.QUALIFIER_IN),
	Rule([OUT_SY] as const, () => Type.QUALIFIER_OUT),
	Rule([INOUT_SY] as const, () => Type.QUALIFIER_INOUT),
);

/**********************/
/* Function Specifier */
/**********************/

const function_specifier = Rules<number>(
	Rule([INLINE_SY] as const, () => Type.MISC_INLINE),
	Rule([INTERNAL_SY] as const, () => Type.MISC_INTERNAL),
);

const abstract_declaration_specifiers2 = Rules<Derived>(self => [
	Rule([type_specifier] as const, 			($, cg) => cg.type_specs.SetDType($[0])),
	Rule([self, type_qualifier] as const, 		($, cg) => { cg.SetTypeQualifiers($[1]); return cg.type_specs; }),
	Rule([self, storage_class] as const, 		($, cg) => { cg.SetStorageClass($[1]); return cg.type_specs; }),
	Rule([self, type_domain] as const, 			($, cg) => { cg.SetTypeDomain($[1]); return cg.type_specs; }),
	Rule([self, in_out] as const, 				($, cg) => { cg.SetTypeQualifiers($[1]); return cg.type_specs; }),
	Rule([self, function_specifier] as const, 	($, cg) => { cg.SetTypeMisc($[1]); return cg.type_specs; }),
	Rule([self, PACKED_SY] as const, 			($, cg) => { cg.SetTypeMisc(Type.MISC_PACKED | Type.MISC_PACKED_KW); return cg.type_specs; }),
]);

const _abstract_declaration_specifiers = Rules<Derived>(self => [
	Rule([abstract_declaration_specifiers2]),
	Rule([type_qualifier, self] as const, 		($, cg) => { cg.SetTypeQualifiers($[0]); return cg.type_specs; }),
	Rule([storage_class, self] as const, 		($, cg) => { cg.SetStorageClass($[0]); return cg.type_specs; }),
	Rule([type_domain, self] as const, 			($, cg) => { cg.SetTypeDomain($[0]); return cg.type_specs; }),
	Rule([in_out, self] as const, 				($, cg) => { cg.SetTypeQualifiers($[0]); return cg.type_specs; }),
	Rule([function_specifier, self] as const,	($, cg) => { cg.SetTypeMisc($[0]); return cg.type_specs; }),
	Rule([PACKED_SY, self] as const, 			($, cg) => { cg.SetTypeMisc(Type.MISC_PACKED | Type.MISC_PACKED_KW); return cg.type_specs; }),
	Rule([ROWMAJOR_SY, self] as const, 			($, cg) => { cg.SetTypeMisc(Type.MISC_ROWMAJOR); return cg.type_specs; }),
	Rule([COLMAJOR_SY, self] as const, 			($, cg) => { cg.ClearTypeMisc(Type.MISC_ROWMAJOR); return cg.type_specs; }),
	Rule([LOWP_SY, self] as const, 				($, cg) => { cg.SetTypeMisc(Type.MISC_PRECISION*1); return cg.type_specs; }),
	Rule([MEDIUMP_SY, self] as const, 			($, cg) => { cg.SetTypeMisc(Type.MISC_PRECISION*2); return cg.type_specs; }),
	Rule([HIGHP_SY, self] as const, 			($, cg) => { cg.SetTypeMisc(Type.MISC_PRECISION*3); return cg.type_specs; }),
]);

const template_param = Rules<Decl>(
	Rule([TYPEDEF_SY, identifier] as const, ($, cg) => cg.NewDeclNode($[1])),
	Rule([abstract_declaration]),
);

const template_params = Rules<Decl[]>(
	Rule([TEMPLATE_SY, '<', ($, cg) => { cg.current_scope!.formal++; }, List(template_param, ','), '>'] as const, ($, cg) => { cg.current_scope!.formal--; return $[3]; }),
);

const template_decl_header = Rules(
	Rule([template_params, STRUCT_SY, struct_identifier] as const, ($, cg) => cg.TemplateHeader($[2], $[0])),
	Rule([template_params, STRUCT_SY, struct_identifier, ':', TYPEIDENT_SY] as const, ($, cg) => cg.TemplateHeader($[2], $[0]).AddStructBase(cg.LookUpTypeSymbol($[4]))),
);

/****************/
/* Template	*/
/****************/
const template_decl = Rules(
	Rule([template_decl_header, '{', ($: any, cg: CG) => { cg.PushScope($[0].str.members); cg.current_scope!.flags |= Scope.is_struct; }, struct_declaration_list, '}'] as const, ($, cg) => { cg.PopScope(); return $[0]; }),
	Rule([template_decl_header]),
);

const _declaration_specifiers = Rules<Derived>(
	Rule([abstract_declaration_specifiers]),
	Rule([template_decl] as const, $ => $[0] as unknown as Derived),
	Rule([TYPEDEF_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(Type.MISC_TYPEDEF); return cg.type_specs; }),
);

const _declaration = Rules<Stmt[]>(
	Rule([declaration_specifiers, ';'] as const, () => []),
	Rule([declaration_specifiers, init_declarator_list, ';'] as const, $ => $[1]),
	Rule([ERROR_SY, ';'] as const, ($, cg) => { cg.RecordErrorPos(); return []; }),
);

const cbuffer_header = Rules<Sym>(
	Rule([CBUFFER_SY, struct_identifier] as const, ($, cg) => cg.ConstantBuffer($[1], 0)),
	Rule([CBUFFER_SY, struct_identifier, ':', register_spec] as const, ($, cg) => cg.ConstantBuffer($[1], $[3])),

);
const cbuffer_compound_header = Rules(
	Rule([compound_header] as const, ($, cg) => { cg.current_scope.flags |= Scope.is_struct | Scope.is_cbuffer; return $[0]; }),
);

/****************/
/* Cbuffer	*/
/****************/
const cbuffer_decl = Rules(
	Rule([cbuffer_header, cbuffer_compound_header, struct_declaration_list, '}'] as const, ($, cg) => cg.SetConstantBuffer($[0], cg.PopScope()!)),
);

const pass_state_value = Rules(
	Rule([state_value]),
	Rule([COMPILE_SY, identifier, identifier, '(', ')'] as const, ($, cg) => cg.SymbolicConstant($[2], $[1])),
	Rule([ASM_SY, '{', assembly, '}'] as const, ($, cg) => cg.SymbolicConstant(0, 0)),
);

const pass_item = Rules(
	Rule([identifier, '=', pass_state_value] as const, ($, cg) => cg.StateInitializer($[0], $[2])),
);

const pass_item_list = Rules<Expr>(self => [
	Rule([pass_item]),
	Rule([self, ';', pass_item] as const, $ => Expr.NewBinopNode('EXPR_LIST', $[0], $[2])),
	Rule([self, ';', ] as const),
]);

const pass = Rules(
	Rule([PASS_SY, identifier, '{', pass_item_list, '}'] as const, ($, cg) => cg.StateInitializer($[1], $[3])),
);

/*******************/
/* Techniques
/*******************/

const pass_list = List(pass);

/****************/
/* Declarations */
/****************/

const external_declaration = Rules<any>(
	Rule([declaration],															($, cg) => cg.GlobalInitStatements($[0])),
	Rule([cbuffer_decl, ';'],													() => undefined),
	Rule([TECHNIQUE_SY, identifier, '{', pass_list, '}'] as const,				($, cg) => { cg.DefineTechnique($[1], $[3]); }),
	Rule([TECHNIQUE_SY, identifier, annotation, '{', pass_list, '}'] as const,	($, cg) => { cg.DefineTechnique($[1], $[4], $[2]); }),
	Rule([function_definition]),
);

const compilation_unit = Rules(self => [
	Rule([external_declaration]),
	Rule([self, external_declaration]),
]);

export const parser = makeParser({
	start: compilation_unit,
	skip: [/\s+/]
});