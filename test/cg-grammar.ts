/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
import { tison, Rule, Rules, terminal, Forward } from '../src/tison';

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
	BOOLEAN_SY     	= "bool",
	BREAK_SY       	= "break",
	CASE_SY        	= "case",
	CFLOATCONST_SY 	= "<cfloat-const>",
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
	FLOATCONST_SY  	= "<float-const>",
	FLOATHCONST_SY 	= "<floath-const>",
	FLOATXCONST_SY 	= "<floatx-const>",
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
	INTCONST_SY    	= "<int-const>",
	UINTCONST_SY   	=  "<uint-const>",
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

	// Type propertes:

enum TYPE {
	BASE_MASK				= 0x0000000f,
	BASE_SHIFT				= 0,
	BASE_BITS				= 4,
	BASE_NO_TYPE			= 0, // e.g. struct or connector
	BASE_UNDEFINED_TYPE,
	BASE_CFLOAT,
	BASE_CINT,
	BASE_VOID,
	BASE_FLOAT,
	BASE_INT,
	BASE_BOOLEAN,
	BASE_UINT,
	BASE_TEXOBJ,
	BASE_STRING,
	BASE_HALF,
	BASE_FIRST_USER,
	BASE_LAST_USER			= 0x0000000f,

	CATEGORY_MASK			= 0x000000f0,
	CATEGORY_SHIFT			= 4,
	CATEGORY_NONE			= 0x00000000,
	CATEGORY_SCALAR			= 0x00000010,
	CATEGORY_ARRAY			= 0x00000020,
	CATEGORY_FUNCTION		= 0x00000030,
	CATEGORY_STRUCT			= 0x00000040,
	CATEGORY_TEXOBJ			= 0x00000050,
	CATEGORY_ENUM			= 0x00000060,

	DOMAIN_MASK				= 0x00000f00,
	DOMAIN_SHIFT			= 8,
	DOMAIN_UNKNOWN			= 0x00000000,
	DOMAIN_UNIFORM			= 0x00000100,
	DOMAIN_VARYING			= 0x00000200,

	QUALIFIER_MASK			= 0x0000f000,
	QUALIFIER_NONE			= 0x00000000,
	QUALIFIER_CONST			= 0x00001000,
	QUALIFIER_IN			= 0x00002000,
	QUALIFIER_OUT			= 0x00004000,
	QUALIFIER_INOUT			= QUALIFIER_IN | QUALIFIER_OUT,

	// ??? Should these be called "declarator bits"???
	MISC_MASK				= 0x7ff00000,
	MISC_TYPEDEF			= 0x00100000,
//	MISC_UNSIGNED			= 0x00200000,
	MISC_ABSTRACT_PARAMS	= 0x00400000,	// Type is function declared with abstract parameters
//	MISC_VOID				= 0x00800000,	// Type is void
	MISC_INLINE				= 0x01000000,	// "static inline" function attribute
	MISC_INTERNAL			= 0x02000000,	// "__internal" function attribute
	MISC_PACKED				= 0x04000000,	// For vector types like float3
	MISC_PACKED_KW			= 0x08000000,	// Actual "packed" keyword used
	MISC_ROWMAJOR			= 0x10000000,
	MISC_PRECISION			= 0x20000000,	// precision for glsl: 0=def, 1=low, 2=med, 3=high
	MISC_MARKED				= 0x80000000,	// Temp value for printing types, etc.
};

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

enum symbolkind {
	VARIABLE_S,
	TYPEDEF_S,
	TEMPLATE_S,
	FUNCTION_S,
	CONSTANT_S,
	TAG_S,
	MACRO_S,
	TECHNIQUE_S,
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

enum SYMB {
	IS_PARAMETER			= 0x000001,	// Symbol is a formal parameter
	IS_DEFINED				= 0x000002,	// Symbol is defined.	Currently only used for functions.
	IS_BUILTIN				= 0x000004,	// Symbol is a built-in function.
	IS_INLINE_FUNCTION		= 0x000008,	// Symbol is a function that will be inlined.
	IS_CONNECTOR_REGISTER	= 0x000010,	// Symbol is a connector hw register
	CONNECTOR_CAN_READ		= 0x000020,	// Symbol is a readable connector hw register
	CONNECTOR_CAN_WRITE		= 0x000040,	// Symbol is a writable connector hw register
	NEEDS_BINDING			= 0x000080,	// Symbol is a non-static global and has not yet been bound
};


const Scope = {
	is_struct:			0x1,
	is_cbuffer:			0x2,
	has_void_param:		0x4,
};

const cgclib = {
	DUMP_PARSETREE:		0x1,
};

enum STMT {//stmtkind {
	EXPR, IF, WHILE, DO, FOR,
	BLOCK, RETURN, DISCARD, BREAK, COMMENT,
	//LAST
};

enum NK {//nodekind {
	DECL, SYMB, CONST, UNARY, BINARY, TRINARY, SYMBOLIC,
	//NK.LASTODEKIND,
};

enum SUB {//subopkind {
	NONE, S, V, VS, SV, M, VM, MV,
	Z, ZM, CS, CV, CM, KV,
};

function Op(name: string, sym: string|number, sym2: string|number, kind: NK, subkind: SUB) {
	return {name, sym, sym2, kind, subkind};
}

const OP = {
	VARIABLE:		Op("var",		IDENT_SY,		0,		NK.SYMB,	SUB.NONE),
	MEMBER:			Op("member",	IDENT_SY,		0,		NK.SYMB,	SUB.NONE),
	
	ICONST:			Op("iconst",	0,				0,		NK.CONST,	SUB.S	),
	ICONST_V:		Op("iconstv",	0,				0,		NK.CONST,	SUB.V	),
	BCONST:			Op("bconst",	0,				0,		NK.CONST,	SUB.S	),
	BCONST_V:		Op("bconstv",	0,				0,		NK.CONST,	SUB.V	),
	FCONST:			Op("fconst",	0,				0,		NK.CONST,	SUB.S	),
	FCONST_V:		Op("fconstv",	0,				0,		NK.CONST,	SUB.V	),
	UCONST:			Op("uconst",	0,				0,		NK.CONST,	SUB.S	),
	UCONST_V:		Op("uconstv",	0,				0,		NK.CONST,	SUB.V	),
	HCONST:			Op("hconst",	0,				0,		NK.CONST,	SUB.S	),
	HCONST_V:		Op("hconstv",	0,				0,		NK.CONST,	SUB.V	),
	XCONST:			Op("xconst",	0,				0,		NK.CONST,	SUB.S	),
	XCONST_V:		Op("xconstv",	0,				0,		NK.CONST,	SUB.V	),
	
	VECTOR_V:		Op("vector",	0,				0,		NK.UNARY,	SUB.V	),
	MATRIX_M:		Op("matrix",	0,				0,		NK.UNARY,	SUB.M	),
	SWIZZLE_Z:		Op("swizzle",	'.',			0,		NK.UNARY,	SUB.Z	),
	SWIZMAT_Z:		Op("swizmat",	'.',			0,		NK.UNARY,	SUB.ZM	),
	CAST_CS:		Op("cast",		'(',			0,		NK.UNARY,	SUB.CS	),
	CAST_CV:		Op("castv",		'(',			0,		NK.UNARY,	SUB.CV	),
	CAST_CM:		Op("castm",		'(',			0,		NK.UNARY,	SUB.CM	),
	NEG:			Op("neg",		'-',			"-",	NK.UNARY,	SUB.S	),
	NEG_V:			Op("negv",		'-',			"-",	NK.UNARY,	SUB.V	),
	POS:			Op("pos",		'+',			"+",	NK.UNARY,	SUB.S	),
	POS_V:			Op("posv",		'+',			"+",	NK.UNARY,	SUB.V	),
	NOT:			Op("not",		'~',			"~",	NK.UNARY,	SUB.S	),
	NOT_V:			Op("notv",		'~',			"~",	NK.UNARY,	SUB.V	),
	BNOT:			Op("bnot",		'!',			"!",	NK.UNARY,	SUB.S	),
	BNOT_V:			Op("bnotv",		'!',			"!",	NK.UNARY,	SUB.V	),
	
	KILL:			Op("kill",		DISCARD_SY,		0,		NK.UNARY,	SUB.S	),
	
	PREDEC:			Op("predec",	MINUSMINUS_SY,	"--",	NK.UNARY,	SUB.S	),
	PREINC:			Op("preinc",	PLUSPLUS_SY,	"++",	NK.UNARY,	SUB.S	),
	POSTDEC:		Op("postdec",	MINUSMINUS_SY,	"--",	NK.UNARY,	SUB.S	),
	POSTINC:		Op("postinc",	PLUSPLUS_SY,	"++",	NK.UNARY,	SUB.S	),
	
	MEMBER_SELECTOR:Op("mselect",	'.',			".",	NK.BINARY,	SUB.NONE),
	ARRAY_INDEX:	Op("index",		'[',			"[]",	NK.BINARY,	SUB.NONE),
	FUN_CALL:		Op("call",		'(',			"()",	NK.BINARY,	SUB.NONE),
	FUN_BUILTIN:	Op("builtin",	0,				0,		NK.BINARY,	SUB.NONE),
	FUN_ARG:		Op("arg",		0,				0,		NK.BINARY,	SUB.NONE),
	EXPR_LIST:		Op("list",		0,				0,		NK.BINARY,	SUB.NONE),
	MUL:			Op("mul",		'*',			"*",	NK.BINARY,	SUB.S	),
	MUL_V:			Op("mulv",		'*',			"*",	NK.BINARY,	SUB.V	),
	MUL_SV:			Op("mulsv",		'*',			"*",	NK.BINARY,	SUB.SV	),
	MUL_VS:			Op("mulvs",		'*',			"*",	NK.BINARY,	SUB.VS	),
	DIV:			Op("div",		'/',			"/",	NK.BINARY,	SUB.S	),
	DIV_V:			Op("divv",		'/',			"/",	NK.BINARY,	SUB.V	),
	DIV_SV:			Op("divsv",		'/',			"/",	NK.BINARY,	SUB.SV	),
	DIV_VS:			Op("divvs",		'/',			"/",	NK.BINARY,	SUB.VS	),
	MOD:			Op("mod",		'%',			"%",	NK.BINARY,	SUB.S	),
	MOD_V:			Op("modv",		'%',			"%",	NK.BINARY,	SUB.V	),
	MOD_SV:			Op("modsv",		'%',			"%",	NK.BINARY,	SUB.SV	),
	MOD_VS:			Op("modvs",		'%',			"%",	NK.BINARY,	SUB.VS	),
	ADD:			Op("add",		'+',			"+",	NK.BINARY,	SUB.S	),
	ADD_V:			Op("addv",		'+',			"+",	NK.BINARY,	SUB.V	),
	ADD_SV:			Op("addsv",		'+',			"+",	NK.BINARY,	SUB.SV	),
	ADD_VS:			Op("addvs",		'+',			"+",	NK.BINARY,	SUB.VS	),
	SUB:			Op("sub",		'-',			"-",	NK.BINARY,	SUB.S	),
	SUB_V:			Op("subv",		'-',			"-",	NK.BINARY,	SUB.V	),
	SUB_SV:			Op("subsv",		'-',			"-",	NK.BINARY,	SUB.SV	),
	SUB_VS:			Op("subvs",		'-',			"-",	NK.BINARY,	SUB.VS	),
	SHL:			Op("shl",		LL_SY,			"<<",	NK.BINARY,	SUB.S	),
	SHL_V:			Op("shlv",		LL_SY,			"<<",	NK.BINARY,	SUB.V	),
	SHR:			Op("shr",		GG_SY,			">>",	NK.BINARY,	SUB.S	),
	SHR_V:			Op("shrv",		GG_SY,			">>",	NK.BINARY,	SUB.V	),
	LT:				Op("lt",		'<',			"<",	NK.BINARY,	SUB.S	),
	LT_V:			Op("ltv",		'<',			"<",	NK.BINARY,	SUB.V	),
	LT_SV:			Op("ltsv",		'<',			"<",	NK.BINARY,	SUB.SV	),
	LT_VS:			Op("ltvs",		'<',			"<",	NK.BINARY,	SUB.VS	),
	GT:				Op("gt",		'>',			">",	NK.BINARY,	SUB.S	),
	GT_V:			Op("gtv",		'>',			">",	NK.BINARY,	SUB.V	),
	GT_SV:			Op("gtsv",		'>',			">",	NK.BINARY,	SUB.SV	),
	GT_VS:			Op("gtvs",		'>',			">",	NK.BINARY,	SUB.VS	),
	LE:				Op("le",		LE_SY,			"<=",	NK.BINARY,	SUB.S	),
	LE_V:			Op("lev",		LE_SY,			"<=",	NK.BINARY,	SUB.V	),
	LE_SV:			Op("lesv",		LE_SY,			"<=",	NK.BINARY,	SUB.SV	),
	LE_VS:			Op("levs",		LE_SY,			"<=",	NK.BINARY,	SUB.VS	),
	GE:				Op("ge",		GE_SY,			">=",	NK.BINARY,	SUB.S	),
	GE_V:			Op("gev",		GE_SY,			">=",	NK.BINARY,	SUB.V	),
	GE_SV:			Op("gesv",		GE_SY,			">=",	NK.BINARY,	SUB.SV	),
	GE_VS:			Op("gevs",		GE_SY,			">=",	NK.BINARY,	SUB.VS	),
	EQ:				Op("eq",		EQ_SY,			"==",	NK.BINARY,	SUB.S	),
	EQ_V:			Op("eqv",		EQ_SY,			"==",	NK.BINARY,	SUB.V	),
	EQ_SV:			Op("eqsv",		EQ_SY,			"==",	NK.BINARY,	SUB.SV	),
	EQ_VS:			Op("eqvs",		EQ_SY,			"==",	NK.BINARY,	SUB.VS	),
	NE:				Op("ne",		NE_SY,			"!=",	NK.BINARY,	SUB.S	),
	NE_V:			Op("nev",		NE_SY,			"!=",	NK.BINARY,	SUB.V	),
	NE_SV:			Op("nesv",		NE_SY,			"!=",	NK.BINARY,	SUB.SV	),
	NE_VS:			Op("nevs",		NE_SY,			"!=",	NK.BINARY,	SUB.VS	),
	AND:			Op("and",		'&',			"&",	NK.BINARY,	SUB.S	),
	AND_V:			Op("andv",		'&',			"&",	NK.BINARY,	SUB.V	),
	AND_SV:			Op("andsv",		'&',			"&",	NK.BINARY,	SUB.SV	),
	AND_VS:			Op("andvs",		'&',			"&",	NK.BINARY,	SUB.VS	),
	XOR:			Op("xor",		'^',			"^",	NK.BINARY,	SUB.S	),
	XOR_V:			Op("xorv",		'^',			"^",	NK.BINARY,	SUB.V	),
	XOR_SV:			Op("xorsv",		'^',			"^",	NK.BINARY,	SUB.SV	),
	XOR_VS:			Op("xorvs",		'^',			"^",	NK.BINARY,	SUB.VS	),
	OR:				Op("or",		'|',			"|",	NK.BINARY,	SUB.S	),
	OR_V:			Op("orv",		'|',			"|",	NK.BINARY,	SUB.V	),
	OR_SV:			Op("orsv",		'|',			"|",	NK.BINARY,	SUB.SV	),
	OR_VS:			Op("orvs",		'|',			"|",	NK.BINARY,	SUB.VS	),
	BAND:			Op("band",		AND_SY,			"&&",	NK.BINARY,	SUB.S	),
	BAND_V:			Op("bandv",		AND_SY,			"&&",	NK.BINARY,	SUB.V	),
	BAND_SV:		Op("bandsv",	AND_SY,			"&&",	NK.BINARY,	SUB.SV	),
	BAND_VS:		Op("bandvs",	AND_SY,			"&&",	NK.BINARY,	SUB.VS	),
	BOR:			Op("bor",		OR_SY,			"||",	NK.BINARY,	SUB.S	),
	BOR_V:			Op("borv",		OR_SY,			"||",	NK.BINARY,	SUB.V	),
	BOR_SV:			Op("borsv",		OR_SY,			"||",	NK.BINARY,	SUB.SV	),
	BOR_VS:			Op("borvs",		OR_SY,			"||",	NK.BINARY,	SUB.VS	),
	ASSIGN:			Op("assign",	'=',			"=",	NK.BINARY,	SUB.S	),
	ASSIGN_V:		Op("assignv",	'=',			"=",	NK.BINARY,	SUB.V	),
	ASSIGN_GEN:		Op("assigngen",	'=',			"=",	NK.BINARY,	SUB.NONE),
	ASSIGN_MASKED_KV:Op("assignm",	'=',			"=",	NK.BINARY,	SUB.KV	),
	
	ASSIGNMINUS:	Op("assign-",	ASSIGNMINUS_SY,	"-=",	NK.BINARY,	SUB.S	),
	ASSIGNMOD:		Op("assign%",	ASSIGNMOD_SY,	"%=",	NK.BINARY,	SUB.S	),
	ASSIGNPLUS:		Op("assign+",	ASSIGNPLUS_SY,	"+=",	NK.BINARY,	SUB.S	),
	ASSIGNSLASH:	Op("assign/",	ASSIGNSLASH_SY,	"/=",	NK.BINARY,	SUB.S	),
	ASSIGNSTAR:		Op("assign*",	ASSIGNSTAR_SY,	"*=",	NK.BINARY,	SUB.S	),
	ASSIGNAND:		Op("assign&",	ASSIGNAND_SY,	"&=",	NK.BINARY,	SUB.S	),
	ASSIGNOR:		Op("assign|",	ASSIGNOR_SY,	"|=",	NK.BINARY,	SUB.S	),
	ASSIGNXOR:		Op("assign^",	ASSIGNXOR_SY,	"^=",	NK.BINARY,	SUB.S	),
	COMMA:			Op("comma",		',',			0,		NK.BINARY,	SUB.NONE),
	
	COND:			Op("cond",		'?',			0,		NK.TRINARY,	SUB.S	),
	COND_V:			Op("condv",		'?',			0,		NK.TRINARY,	SUB.V	),
	COND_SV:		Op("condsv",	'?',			0,		NK.TRINARY,	SUB.SV	),
	COND_GEN:		Op("condgen",	'?',			0,		NK.TRINARY,	SUB.NONE),
	ASSIGN_COND:	Op("assc",		'@',			0,		NK.TRINARY,	SUB.S	),
	ASSIGN_COND_V:	Op("asscv",		'@',			0,		NK.TRINARY,	SUB.V	),
	ASSIGN_COND_SV:	Op("asscsc",	'@',			0,		NK.TRINARY,	SUB.VS	),
	ASSIGN_COND_GEN:Op("asscgen",	'@',			0,		NK.TRINARY,	SUB.NONE),
};


/*
interface Type {
	int			properties;
	int			size;
	union {
		struct {
			Type		*eltype;
			int			numels;
		} arr;

		struct {						// for structs and connectors and templates
			Type		*unqualifiedtype;
			Type		*base;
			Scope		*members;
			int			tag;			// struct or connector tag
			int			semantics;
//			char		*allocated;		// set if corresponding register has been bound
//			int			csize;
		} str;

		struct {
			Type		*rettype;
			TypeList	*paramtypes;
		} fun;

		struct {
			Type		*eltype;
			int			dims;	//1D, 2D, 3D, Cube, rect
		} tex;

		struct {
			int			tag;
			Scope		*members;
		} enm;

		struct {						// template parameter
			int			index;
		} typname;
	};

};
*/

type dummy	= any;
type spec	= any;
type dtype	= any;
type decl	= any;
type expr	= any;
type stmt	= any;
type attr	= any;
type Type	= any;
type sym	= any

type sc_token		= number;
type sc_int			= number;
type sc_fval		= number;
type sc_ident		= number;
type sc_specifiers	= spec;
type sc_type		= dtype;
type sc_ptype		= Type;
type sc_typelist	= Type[];
type sc_decl		= decl;
type sc_expr		= expr;
type sc_stmt		= stmt;
type sc_attr		= attr;
type sc_sym			= sym;

const compilation_unit 					= Forward<dummy>(()=>_compilation_unit);
const compound_header 					= Forward<dummy>(()=>_compound_header);
const compound_tail 					= Forward<dummy>(()=>_compound_tail);
const external_declaration 				= Forward<dummy>(()=>_external_declaration);
const function_definition 				= Forward<dummy>(()=>_function_definition);
const struct_compound_header 			= Forward<dummy>(()=>_struct_compound_header);
const cbuffer_compound_header 			= Forward<dummy>(()=>_cbuffer_compound_header);
const enum_declaration_list 			= Forward<dummy>(()=>_enum_declaration_list);
const enum_declaration 					= Forward<dummy>(()=>_enum_declaration);

const function_specifier 				= Forward<sc_int>(()=>_function_specifier);
const in_out 							= Forward<sc_int>(()=>_in_out);
const type_domain 						= Forward<sc_int>(()=>_type_domain);
const type_qualifier 					= Forward<sc_int>(()=>_type_qualifier);
const storage_class 					= Forward<sc_int>(()=>_storage_class);

const operator 							= Forward<sc_ident>(()=>_operator);
const identifier 						= Forward<sc_ident>(()=>_identifier);
const member_identifier 				= Forward<sc_ident>(()=>_member_identifier);
const scope_identifier 					= Forward<sc_ident>(()=>_scope_identifier);
const semantics_identifier 				= Forward<sc_ident>(()=>_semantics_identifier);
const struct_identifier 				= Forward<sc_ident>(()=>_struct_identifier);
const variable_identifier 				= Forward<sc_ident>(()=>_variable_identifier);
const register_spec 					= Forward<sc_ident>(()=>_register_spec);

const abstract_declaration 				= Forward<sc_decl>(()=>_abstract_declaration);
const abstract_declarator 				= Forward<sc_decl>(()=>_abstract_declarator);
const abstract_parameter_list 			= Forward<sc_decl>(()=>_abstract_parameter_list);
const declarator 						= Forward<sc_decl>(()=>_declarator);
const basic_declarator 					= Forward<sc_decl>(()=>_basic_declarator);
const semantic_declarator 				= Forward<sc_decl>(()=>_semantic_declarator);
const function_decl_header 				= Forward<sc_decl>(()=>_function_decl_header);
const function_definition_header 		= Forward<sc_decl>(()=>_function_definition_header);
const non_empty_abstract_parameter_list = Forward<sc_decl>(()=>_non_empty_abstract_parameter_list);
const parameter_declaration 			= Forward<sc_decl>(()=>_parameter_declaration);
const parameter_list 					= Forward<sc_decl>(()=>_parameter_list);
const template_param 					= Forward<sc_decl>(()=>_template_param);
const template_param_list 				= Forward<sc_decl>(()=>_template_param_list);
const template_params 					= Forward<sc_decl>(()=>_template_params);
const template_arg_list 				= Forward<sc_typelist>(()=>_template_arg_list);
const non_empty_template_arg_list 		= Forward<sc_typelist>(()=>_non_empty_template_arg_list);

const abstract_declaration_specifiers 	= Forward<sc_type>(()=>_abstract_declaration_specifiers);
const abstract_declaration_specifiers2 	= Forward<sc_type>(()=>_abstract_declaration_specifiers2);
/*cons_declaration_specifiers 			= Forward<sc_type>(()=>_declaration_specifiers);*/
const template_decl 					= Forward<sc_ptype>(()=>_template_decl);
const template_decl_header 				= Forward<sc_ptype>(()=>_template_decl_header);
const struct_or_connector_header 		= Forward<sc_ptype>(()=>_struct_or_connector_header);
const struct_or_connector_specifier 	= Forward<sc_ptype>(()=>_struct_or_connector_specifier);
const enum_specifier 					= Forward<sc_ptype>(()=>_enum_specifier);
const enum_header 						= Forward<sc_ptype>(()=>_enum_header);
const untagged_enum_header 				= Forward<sc_ptype>(()=>_untagged_enum_header);
const type_specifier 					= Forward<sc_ptype>(()=>_type_specifier);
const untagged_struct_header 			= Forward<sc_ptype>(()=>_untagged_struct_header);
const templated_type 					= Forward<sc_ptype>(()=>_templated_type);
const template_arg 						= Forward<sc_ptype>(()=>_template_arg);

const cbuffer_header 					= Forward<sc_sym>(()=>_cbuffer_header);

const actual_argument_list 				= Forward<sc_expr>(()=>_actual_argument_list);
const additive_expression 				= Forward<sc_expr>(()=>_additive_expression);
const AND_expression 					= Forward<sc_expr>(()=>_AND_expression);
const basic_variable 					= Forward<sc_expr>(()=>_basic_variable);
const boolean_expression_opt 			= Forward<sc_expr>(()=>_boolean_expression_opt);
const boolean_scalar_expression 		= Forward<sc_expr>(()=>_boolean_scalar_expression);
const cast_expression 					= Forward<sc_expr>(()=>_cast_expression);
const conditional_expression 			= Forward<sc_expr>(()=>_conditional_expression);
const constant 							= Forward<sc_expr>(()=>_constant);

const constant_expression 				= Forward<sc_int>(()=>_constant_expression);

const conditional_test 					= Forward<sc_expr>(()=>_conditional_test);
const equality_expression 				= Forward<sc_expr>(()=>_equality_expression);
const exclusive_OR_expression 			= Forward<sc_expr>(()=>_exclusive_OR_expression);
const expression 						= Forward<sc_expr>(()=>_expression);
const expression_list 					= Forward<sc_expr>(()=>_expression_list);
const inclusive_OR_expression 			= Forward<sc_expr>(()=>_inclusive_OR_expression);
const initializer 						= Forward<sc_expr>(()=>_initializer);
const initializer_list 					= Forward<sc_expr>(()=>_initializer_list);
const logical_AND_expression 			= Forward<sc_expr>(()=>_logical_AND_expression);
const logical_OR_expression 			= Forward<sc_expr>(()=>_logical_OR_expression);
const multiplicative_expression 		= Forward<sc_expr>(()=>_multiplicative_expression);
const non_empty_argument_list 			= Forward<sc_expr>(()=>_non_empty_argument_list);
const postfix_expression 				= Forward<sc_expr>(()=>_postfix_expression);
const primary_expression 				= Forward<sc_expr>(()=>_primary_expression);
const relational_expression 			= Forward<sc_expr>(()=>_relational_expression);
const shift_expression 					= Forward<sc_expr>(()=>_shift_expression);
const unary_expression 					= Forward<sc_expr>(()=>_unary_expression);
const variable 							= Forward<sc_expr>(()=>_variable);

const annotation 						= Forward<sc_stmt>(()=>_annotation);
const annotation_decl_list 				= Forward<sc_stmt>(()=>_annotation_decl_list);
const attribute 						= Forward<sc_attr>(()=>_attribute);
const balanced_statement 				= Forward<sc_stmt>(()=>_balanced_statement);
const block_item 						= Forward<sc_stmt>(()=>_block_item);
const block_item_list 					= Forward<sc_stmt>(()=>_block_item_list);
const compound_statement 				= Forward<sc_stmt>(()=>_compound_statement);
const dangling_if 						= Forward<sc_stmt>(()=>_dangling_if);
const dangling_iteration 				= Forward<sc_stmt>(()=>_dangling_iteration);
const dangling_statement 				= Forward<sc_stmt>(()=>_dangling_statement);
const declaration 						= Forward<sc_stmt>(()=>_declaration);
const discard_statement 				= Forward<sc_stmt>(()=>_discard_statement);
const break_statement 					= Forward<sc_stmt>(()=>_break_statement);
const expression_statement 				= Forward<sc_stmt>(()=>_expression_statement);
const expression_statement2 			= Forward<sc_stmt>(()=>_expression_statement2);
const for_expression 					= Forward<sc_stmt>(()=>_for_expression);
const for_expression_opt 				= Forward<sc_stmt>(()=>_for_expression_opt);
const for_expression_init 				= Forward<sc_stmt>(()=>_for_expression_init);
const if_header 						= Forward<sc_stmt>(()=>_if_header);
const if_statement 						= Forward<sc_stmt>(()=>_if_statement);
const switch_statement 					= Forward<sc_stmt>(()=>_switch_statement);
const init_declarator 					= Forward<sc_stmt>(()=>_init_declarator);
const init_declarator_list 				= Forward<sc_stmt>(()=>_init_declarator_list);
const iteration_statement 				= Forward<sc_stmt>(()=>_iteration_statement);
const return_statement 					= Forward<sc_stmt>(()=>_return_statement);
const assembly 							= Forward<sc_stmt>(()=>_assembly);
const asm_statement 					= Forward<sc_stmt>(()=>_asm_statement);
const statement 						= Forward<sc_stmt>(()=>_statement);
const labeled_statement 				= Forward<sc_stmt>(()=>_labeled_statement);
const switch_item_list 					= Forward<sc_stmt>(()=>_switch_item_list);
const struct_declaration_list 			= Forward<sc_stmt>(()=>_struct_declaration_list);
const struct_declaration 				= Forward<sc_stmt>(()=>_struct_declaration);
const state_list 						= Forward<sc_expr>(()=>_state_list);
const state 							= Forward<sc_expr>(()=>_state);
const state_value 						= Forward<sc_expr>(()=>_state_value);
const pass 								= Forward<sc_expr>(()=>_pass);
const pass_list 						= Forward<sc_expr>(()=>_pass_list);
const pass_item 						= Forward<sc_expr>(()=>_pass_item);
const pass_item_list 					= Forward<sc_expr>(()=>_pass_item_list);
const pass_state_value 					= Forward<sc_expr>(()=>_pass_state_value);

const cbuffer_decl 						= Forward<sc_expr>(()=>_cbuffer_decl);
const declaration_specifiers 			= Forward<sc_expr>(()=>_declaration_specifiers);

//dummy functions
function AddDecl(..._: any) { return 0; }
function AddDeclAttribute(..._: any) { return 0; }
function AddStmt(..._: any) { return 0; }
function AddStmtAttribute(..._: any) { return 0; }
function AddStructBase(..._: any) { return 0; }
function AddtoTypeList(..._: any) { return 0; }
function ArgumentList(..._: any) { return 0; }
function NewBinaryBooleanOperator(..._: any) { return 0; }
function NewBinaryComparisonOperator(..._: any) { return 0; }
function NewBinaryOperator(..._: any) { return 0; }
function NewBlockStmt(..._: any) { return 0; }
function NewBreakStmt(..._: any) { return 0; }
function NewCastOperator(..._: any) { return 0; }
function NewCompoundAssignmentStmt(..._: any) { return 0; }
function NewConditionalOperator(..._: any) { return 0; }
function NewConstructor(..._: any) { return 0; }
function NewDeclNode(..._: any) { return 0; }
function NewDiscardStmt(..._: any) { return 0; }
function NewExprStmt(..._: any) { return 0; }
function NewFConstNode(..._: any) { return 0; }
function NewForStmt(..._: any) { return 0; }
function NewFunctionCallOperator(..._: any) { return 0; }
function NewIConstNode(..._: any) { return 0; }
function NewIfStmt(..._: any) { return 0; }
function NewIndexOperator(..._: any) { return 0; }
function NewMemberSelectorOrSwizzleOrWriteMaskOperator(..._: any) { return 0; }
function NewReturnStmt(..._: any) { return 0; }
function NewSimpleAssignmentStmt(..._: any) { return 0; }
function NewSwitchStmt(..._: any) { return 0; }
function NewUnaryOperator(..._: any) { return 0; }
function NewUnopNode(..._: any) { return 0; }
function NewUnopSubNode(..._: any) { return 0; }
function NewWhileStmt(..._: any) { return 0; }

function Array_Declarator(..._: any) { return 0; }
function Attribute(..._: any) { return 0; }
function BasicVariable(..._: any) { return 0; }
function CheckBooleanExpr(..._: any) { return {result: 0, len: 0}; }
function CheckStmt(..._: any) { return 0; }
function ConstantBuffer(..._: any) { return 0; }
function Declarator(..._: any) { return 0; }
function DefineFunction(..._: any) { return 0; }
function EnumAdd(..._: any) { return 0; }
function EnumHeader(..._: any) { return 0; }
function ExpressionList(..._: any) { return 0; }
function FunctionDeclHeader(..._: any) { return 0; }
function Function_Definition_Header(..._: any) { return 0; }
function GetConstant(..._: any) { return 0; }
function GetOperatorName(..._: any) { return 0; }
function GetTypePointer(..._: any) { return 0; }
function Init_Declarator(..._: any) { return 0; }
function Initializer(..._: any) { return 0; }
function InitializerList(..._: any) { return 0; }
function InstantiateTemplate(..._: any) { return 0; }
function IntToType(..._: any) { return 0; }
function IsVoid(..._: any) { return false; }
function LookUpTypeSymbol(..._: any) { return 0; }
function Param_Init_Declarator(..._: any) { return 0; }
function ParseAsm(..._: any) { return 0; }
function PrintScopeDeclarations(..._: any) { return 0; }
function SUBOP_V(..._: any) { return 0; }
function SemanticError(..._: any) { return 0; }
function SemanticParseError(..._: any) { return 0; }
function SetConstantBuffer(..._: any) { return 0; }
function SetDType(..._: any) { return 0; }
function SetFunTypeParams(..._: any) { return 0; }
function SetStructMembers(..._: any) { return 0; }
function SetThenElseStmts(..._: any) { return 0; }
function StateInitializer(..._: any) { return 0; }
function StructHeader(..._: any) { return 0; }
function SymbolicConstant(..._: any) { return 0; }
function TemplateHeader(..._: any) { return 0; }

function GlobalInitStatements(..._: any[]) { return 0; }
function DefineTechnique(..._: any[]) { return 0; }
function RecordErrorPos(..._: any[]) { return 0; }

const error = terminal('error');
const UndefinedType = 0;
const ERROR_S_TYPE = { NAME_EXPECTED: 0 };
const ERROR___VOIDOT_ONLY_PARAM = 0;

const NULL = 0;
/* Operator precedence rules: */

const _compilation_unit = Rules<any>(
	Rule([external_declaration] as const),
	Rule([compilation_unit, external_declaration] as const),
);

/****************/
/* Declarations */
/****************/

const _external_declaration = Rules<any>(
	Rule([declaration] as const, ($, cg) => GlobalInitStatements(cg.current_scope, $[0])),
	Rule([cbuffer_decl, ';'] as const, () => NULL),
	Rule([TECHNIQUE_SY, identifier, '{', pass_list, '}'] as const, ($, cg) => { DefineTechnique(cg, $[1], $[3], NULL); }),
	Rule([TECHNIQUE_SY, identifier, annotation, '{', pass_list, '}'] as const, ($, cg) => { DefineTechnique(cg, $[1], $[4], $[2]); }),
	Rule([function_definition] as const),
);

const _declaration = Rules<any>(
	Rule([declaration_specifiers, ';'] as const, () => NULL),
	Rule([declaration_specifiers, init_declarator_list, ';'] as const, $ => $[1]),
	Rule([ERROR_SY, ';'] as const, ($, cg) => { RecordErrorPos(cg.tokenLoc); return NULL; }),
);

const _abstract_declaration = Rules<any>(
	Rule([abstract_declaration_specifiers, abstract_declarator] as const, $ => $[1]),
);

const _declaration_specifiers = Rules<any>(
	Rule([abstract_declaration_specifiers] as const),
	Rule([template_decl] as const),
	Rule([TYPEDEF_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_TYPEDEF); }),
);

const _abstract_declaration_specifiers = Rules<any>(
	Rule([abstract_declaration_specifiers2] as const, $ => $[0]),
	Rule([type_qualifier, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeQualifiers($[0]); return cg.type_specs; }),
	Rule([storage_class, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetStorageClass($[0]); return cg.type_specs; }),
	Rule([type_domain, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeDomain($[0]); return cg.type_specs; }),
	Rule([in_out, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeQualifiers($[0]); return cg.type_specs; }),
	Rule([function_specifier, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc($[0]); return cg.type_specs; }),
	Rule([PACKED_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_PACKED | TYPE.MISC_PACKED_KW); return cg.type_specs; }),
	Rule([ROWMAJOR_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_ROWMAJOR); return cg.type_specs; }),
	Rule([COLMAJOR_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.ClearTypeMisc(TYPE.MISC_ROWMAJOR); return cg.type_specs; }),
	Rule([LOWP_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_PRECISION*1); return cg.type_specs; }),
	Rule([MEDIUMP_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_PRECISION*2); return cg.type_specs; }),
	Rule([HIGHP_SY, abstract_declaration_specifiers] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_PRECISION*3); return cg.type_specs; }),
);

const _abstract_declaration_specifiers2 = Rules<any>(
	Rule([type_specifier] as const, ($, cg) => SetDType(cg.type_specs, $[0])),
	Rule([abstract_declaration_specifiers2, type_qualifier] as const, ($, cg) => { cg.SetTypeQualifiers($[1]); return cg.type_specs; }),
	Rule([abstract_declaration_specifiers2, storage_class] as const, ($, cg) => { cg.SetStorageClass($[1]); return cg.type_specs; }),
	Rule([abstract_declaration_specifiers2, type_domain] as const, ($, cg) => { cg.SetTypeDomain($[1]); return cg.type_specs; }),
	Rule([abstract_declaration_specifiers2, in_out] as const, ($, cg) => { cg.SetTypeQualifiers($[1]); return cg.type_specs; }),
	Rule([abstract_declaration_specifiers2, function_specifier] as const, ($, cg) => { cg.SetTypeMisc($[1]); return cg.type_specs; }),
	Rule([abstract_declaration_specifiers2, PACKED_SY] as const, ($, cg) => { cg.SetTypeMisc(TYPE.MISC_PACKED | TYPE.MISC_PACKED_KW); return cg.type_specs; }),
);

const _init_declarator_list = Rules<any>(
	Rule([init_declarator] as const, $ => $[0]),
	Rule([init_declarator_list, ',', init_declarator] as const, $ => AddStmt($[0], $[2])),
);

const _init_declarator = Rules<any>(
	Rule([declarator] as const, ($, cg) => Init_Declarator(cg, $[0], NULL)),
	Rule([declarator, '=', initializer] as const, ($, cg) => Init_Declarator(cg, $[0], $[2])),
);

/*******************/
/* Techniques
/*******************/

const _pass_list = Rules<any>(
	Rule([pass] as const, $ => InitializerList($[0], NULL)),
	Rule([pass_list, pass] as const, $ => InitializerList($[0], $[1])),
);

const _pass = Rules<any>(
	Rule([PASS_SY, identifier, '{', pass_item_list, '}'] as const, ($, cg) => StateInitializer(cg, $[1], $[3])),
);

const _pass_item_list = Rules<any>(
	Rule([pass_item] as const, $ => InitializerList($[0], NULL)),
	Rule([pass_item_list, ';', pass_item] as const, $ => InitializerList($[0], $[2])),
	Rule([pass_item_list, ';', ] as const, $ => $[0]),
);

const _pass_item = Rules<any>(
	Rule([identifier, '=', pass_state_value] as const, ($, cg) => StateInitializer(cg, $[0], $[2])),
);

const _pass_state_value = Rules<any>(
	Rule([state_value] as const),
	Rule([COMPILE_SY, identifier, identifier, '(', ')'] as const, ($, cg) => SymbolicConstant(cg, $[2], $[1])),
	Rule([ASM_SY, '{', assembly, '}'] as const, ($, cg) => SymbolicConstant(cg, 0, 0)),
);

const _assembly = Rules<any>(
	Rule([($, cg) => ParseAsm(cg, cg.tokenLoc)])
);


/*******************/
/* Type Specifiers */
/*******************/

const _type_specifier = Rules<any>(
	Rule([INT_SY] as const, ($, cg) => LookUpTypeSymbol(cg, INT_SY)),
	Rule([UNSIGNED_SY, INT_SY] as const, ($, cg) => LookUpTypeSymbol(cg, INT_SY)),
	Rule([FLOAT_SY] as const, ($, cg) => LookUpTypeSymbol(cg, FLOAT_SY)),
	Rule([VOID_SY] as const, ($, cg) => LookUpTypeSymbol(cg, VOID_SY)),
	Rule([BOOLEAN_SY] as const, ($, cg) => LookUpTypeSymbol(cg, BOOLEAN_SY)),
	Rule([TEXOBJ_SY] as const, ($, cg) => LookUpTypeSymbol(cg, TEXOBJ_SY)),
	Rule([enum_specifier] as const, $ => $[0]),
	Rule([struct_or_connector_specifier] as const, $ => $[0]),
	Rule([TYPEIDENT_SY] as const, ($, cg) => LookUpTypeSymbol(cg, $[0])),
	Rule([templated_type] as const, $ => $[0]),
	Rule([error] as const, ($, cg) => {SemanticParseError(cg, cg.tokenLoc, ERROR_S_TYPE.NAME_EXPECTED, cg.GetAtomString(cg.last_token /* yychar */)); return UndefinedType; })
);

/*******************/
/* Type Qualifiers */
/*******************/

const _type_qualifier = Rules<any>(
	Rule([CONST_SY] as const, () => TYPE.QUALIFIER_CONST),
);

/****************/
/* Type Domains */
/****************/

const _type_domain = Rules<any>(
	Rule([UNIFORM_SY] as const, () => TYPE.DOMAIN_UNIFORM),
);

/*******************/
/* Storage Classes */
/*******************/

const _storage_class = Rules<any>(
	Rule([STATIC_SY] as const, () => SC.STATIC),
	Rule([EXTERN_SY] as const, () => SC.EXTERN),
	Rule([NOINTERP_SY] as const, () => SC.NOINTERP),
	Rule([PRECISE_SY] as const, () => SC.PRECISE),
	Rule([SHARED_SY] as const, () => SC.SHARED),
	Rule([GROUPSHARED_SY] as const, () => SC.GROUPSHARED),
	Rule([VOLATILE_SY] as const, () => SC.UNKNOWN),
);

/**********************/
/* Function Specifier */
/**********************/

const _function_specifier = Rules<any>(
	Rule([INLINE_SY] as const, () => TYPE.MISC_INLINE),
	Rule([INTERNAL_SY] as const, () => TYPE.MISC_INTERNAL),
);

/**********/
/* In Out */
/**********/

const _in_out = Rules<any>(
	Rule([IN_SY] as const, () => TYPE.QUALIFIER_IN),
	Rule([OUT_SY] as const, () => TYPE.QUALIFIER_OUT),
	Rule([INOUT_SY] as const, () => TYPE.QUALIFIER_INOUT),
);

/****************/
/* Struct Types */
/****************/

const _struct_or_connector_specifier = Rules<any>(
	Rule([struct_or_connector_header, struct_compound_header, struct_declaration_list, '}'] as const, ($, cg) => SetStructMembers(cg, $[0], cg.PopScope())),
	Rule([untagged_struct_header, struct_compound_header, struct_declaration_list, '}'] as const, ($, cg) => SetStructMembers(cg, $[0], cg.PopScope())),
	Rule([struct_or_connector_header] as const, $ => $[0]),
);

const _struct_compound_header = Rules<any>(
	Rule([compound_header] as const, ($, cg) => { cg.current_scope.flags |= Scope.is_struct; return $[0]; }),
);

const _struct_or_connector_header = Rules<any>(
	Rule([STRUCT_SY, struct_identifier] as const, ($, cg) => StructHeader(cg, cg.tokenLoc, cg.current_scope, 0, $[1])),
	Rule([STRUCT_SY, struct_identifier, ':', semantics_identifier] as const, ($, cg) => StructHeader(cg, cg.tokenLoc, cg.current_scope, $[3], $[1])),
	Rule([STRUCT_SY, struct_identifier, ':', TYPEIDENT_SY] as const, ($, cg) => AddStructBase(StructHeader(cg, cg.tokenLoc, cg.current_scope, 0, $[1]), LookUpTypeSymbol(cg, $[3]))),
);

const _struct_identifier = Rules<any>(
	Rule([identifier] as const),
	Rule([TYPEIDENT_SY] as const),
);

const _untagged_struct_header = Rules<any>(
	Rule([STRUCT_SY] as const, ($, cg) => StructHeader(cg, cg.tokenLoc, cg.current_scope, 0, 0)),
);

const _struct_declaration_list = Rules<any>(
	Rule([struct_declaration] as const),
	Rule([struct_declaration_list, struct_declaration] as const),
);

const _struct_declaration = Rules<any>(
	Rule([declaration] as const),
	Rule([function_definition] as const),
);

/****************/
/* Cbuffer	*/
/****************/
const _cbuffer_decl = Rules<any>(
	Rule([cbuffer_header, cbuffer_compound_header, struct_declaration_list, '}'] as const, ($, cg) => { SetConstantBuffer(cg, cg.tokenLoc, $[0], cg.PopScope()); }),
);
const _cbuffer_compound_header = Rules<any>(
	Rule([compound_header] as const, ($, cg) => { cg.current_scope.flags |= Scope.is_struct | Scope.is_cbuffer; return $[0]; }),
);

const _cbuffer_header = Rules<any>(
	Rule([CBUFFER_SY, struct_identifier] as const, ($, cg) => ConstantBuffer(cg, cg.tokenLoc, cg.current_scope, $[1], 0)),
	Rule([CBUFFER_SY, struct_identifier, ':', register_spec] as const, ($, cg) => ConstantBuffer(cg, cg.tokenLoc, cg.current_scope, $[1], $[3])),

);

/****************/
/* Template	*/
/****************/
const _template_decl = Rules<any>(
	Rule([template_decl_header, '{', ($: any, cg: any) => { cg.PushScope($[0].str.members); cg.current_scope.flags |= Scope.is_struct; }, struct_declaration_list, '}'] as const, ($, cg) => { cg.PopScope(); return $[0]; }),
	Rule([template_decl_header] as const),
);

const _template_decl_header = Rules<any>(
	Rule([template_params, STRUCT_SY, struct_identifier] as const, ($, cg) => TemplateHeader(cg, cg.tokenLoc, cg.current_scope, $[2], $[0])),
	Rule([template_params, STRUCT_SY, struct_identifier, ':', TYPEIDENT_SY] as const, ($, cg) => AddStructBase(TemplateHeader(cg, cg.tokenLoc, cg.current_scope, $[2], $[0]), LookUpTypeSymbol(cg, $[4]))),
);

const _template_params = Rules<any>(
	Rule([TEMPLATE_SY, '<', ($, cg) => { cg.current_scope.formal++; }, template_param_list, '>'] as const, ($, cg) => { cg.current_scope.formal--; return $[3]; }),
);

const _template_param_list = Rules<any>(
	Rule([template_param] as const, $ => $[0]),
	Rule([template_param_list, ',', template_param] as const, $ => AddDecl($[0], $[2])),
);

const _template_param = Rules<any>(
	Rule([TYPEDEF_SY, identifier] as const, ($, cg) => NewDeclNode(cg.tokenLoc, $[1], 0)),
	Rule([abstract_declaration] as const, $ => $[0]),
);

/****************/
/* Templated Types */
/****************/

const _templated_type = Rules<any>(
	Rule([TEMPLATEIDENT_SY] as const, ($, cg) => InstantiateTemplate(cg, cg.tokenLoc, cg.current_scope, LookUpTypeSymbol(cg, $[0]), 0)),
	Rule([TEMPLATEIDENT_SY, '<', template_arg_list, '>'] as const, ($, cg) => InstantiateTemplate(cg, cg.tokenLoc, cg.current_scope, LookUpTypeSymbol(cg, $[0]), $[2])),
);
const _template_arg_list = Rules<any>(
	Rule([/*, empty, */] as const, () => NULL),
	Rule([non_empty_template_arg_list] as const),
);

const _non_empty_template_arg_list = Rules<any>(
	Rule([template_arg] as const, ($, cg) => AddtoTypeList(cg, NULL, $[0])),
	Rule([non_empty_template_arg_list, ',', template_arg] as const, ($, cg) => AddtoTypeList(cg, $[0], $[2])),
);

const _template_arg = Rules<any>(
	Rule([type_specifier] as const),
	Rule([additive_expression] as const, ($, cg) => IntToType(cg, GetConstant(cg, $[0], 0))),
);
/****************/
/* Enum Types */
/****************/

const _enum_specifier = Rules<any>(
//	Rule([enum_header, '{', ($, cg) => {SetDType(&cg.type_specs,, $[0]);}, enum_declaration_list, '}'] as const),
//	Rule([untagged_enum_header, '{', ($, cg) => {SetDType(&cg.type_specs,, $[0]);}, enum_declaration_list, '}'] as const),
	Rule([enum_header] as const),
);

const _enum_header = Rules<any>(
	Rule([ENUM_SY, struct_identifier] as const, ($, cg) => EnumHeader(cg, cg.tokenLoc, cg.current_scope, $[1])),
);

const _untagged_enum_header = Rules<any>(
	Rule([ENUM_SY] as const, ($, cg) => EnumHeader(cg, cg.tokenLoc, cg.current_scope, 0)),
);

const _enum_declaration_list = Rules<any>(
	Rule([enum_declaration] as const),
	Rule([enum_declaration_list, ',', enum_declaration] as const),
);

const _enum_declaration = Rules<any>(
	Rule([identifier] as const, ($, cg) => { EnumAdd(cg, cg.tokenLoc, cg.current_scope, cg.type_specs.basetype, $[0], 0); }),
	Rule([identifier, '=', INTCONST_SY] as const, ($, cg) => { EnumAdd(cg, cg.tokenLoc, cg.current_scope, cg.type_specs.basetype, $[0], $[2]); }),
);

/***************/
/* Annotations */
/***************/

const _annotation = Rules<any>(
	Rule(['<', ($, cg) => { cg.PushScope(); }, annotation_decl_list, '>'] as const, ($, cg) => { cg.PopScope(); return $[2]; }),
);

const _annotation_decl_list = Rules<any>(
	Rule([/*, empty, */] as const, () => 0),
	Rule([annotation_decl_list, declaration] as const),
);

/***************/
/* Attributes */
/***************/

const _attribute = Rules<any>(
	Rule(['[', identifier, ']'] as const, $ => Attribute($[1], 0, 0, 0)),
	Rule(['[', identifier, '(', INTCONST_SY, ')', ']'] as const, $ => Attribute($[1], 1, $[3], 0)),
	Rule(['[', identifier, '(', INTCONST_SY, ',', INTCONST_SY, ')', ']'] as const, $ => Attribute($[1], 2, $[3], $[5])),
	Rule(['[', identifier, '(', INTCONST_SY, ',', INTCONST_SY, ',', INTCONST_SY, ')', ']'] as const, $ => Attribute($[1], 3, $[3], $[5], $[7])),
);

/***************/
/* Declarators */
/***************/

const _declarator = Rules<any>(
	Rule([semantic_declarator] as const),
	Rule([semantic_declarator, annotation] as const),
);

const _semantic_declarator = Rules<any>(
	Rule([basic_declarator] as const, ($, cg) => Declarator(cg, $[0], 0, 0)),
	Rule([basic_declarator, ':', semantics_identifier] as const, ($, cg) => Declarator(cg, $[0], $[2], 0)),
	Rule([basic_declarator, ':', register_spec] as const, ($, cg) => Declarator(cg, $[0], 0, $[2])),
	Rule([basic_declarator, ':', semantics_identifier, ':', register_spec] as const, ($, cg) => Declarator(cg, $[0], $[2], $[4])),
);

const _register_spec = Rules<any>(
	Rule([REGISTER_SY, '(', identifier, ')'] as const, $ => $[2]),
	Rule([REGISTER_SY, '(', identifier, ',', identifier, ')'] as const, $ => $[4]),
);

const _basic_declarator = Rules<any>(
	Rule([identifier] as const, ($, cg) => NewDeclNode(cg.tokenLoc, $[0], cg.type_specs)),
	Rule([basic_declarator, '[', constant_expression, ']'] as const, ($, cg) => Array_Declarator(cg, $[0], $[2], 0)),
	Rule([basic_declarator, '[', ']'] as const, ($, cg) => Array_Declarator(cg, $[0], 0, 1)),
	Rule([function_decl_header, parameter_list, ')'] as const, ($, cg) => SetFunTypeParams(cg, $[0], $[1], $[1])),
	Rule([function_decl_header, abstract_parameter_list, ')'] as const, ($, cg) => SetFunTypeParams(cg, $[0], $[1], NULL)),
);

const _function_decl_header = Rules<any>(
	Rule([basic_declarator, '('] as const, ($, cg) => FunctionDeclHeader(cg, $[0].loc, cg.current_scope, $[0])),
	Rule([OPERATOR_SY, operator, '('] as const, ($, cg) => FunctionDeclHeader(cg, cg.tokenLoc, cg.current_scope, NewDeclNode(cg.tokenLoc, GetOperatorName(cg, $[1]), cg.type_specs))),
);

const _operator = Rules<any>(
	Rule(['+'		] as const, () => OP.POS),
	Rule(['-', 		] as const, () => OP.NEG),
	Rule(['!', 		] as const, () => OP.BNOT),
	Rule(['~', 		] as const, () => OP.NOT),
	Rule(['*', 		] as const, () => OP.MUL),
	Rule(['/', 		] as const, () => OP.DIV),
	Rule(['%'		] as const, () => OP.MOD),
	Rule([GG_SY, 	] as const, () => OP.SHR),
	Rule(['<', 		] as const, () => OP.LT),
	Rule(['>', 		] as const, () => OP.GT),
	Rule([LE_SY, 	] as const, () => OP.LE),
	Rule([GE_SY, 	] as const, () => OP.GE),
	Rule([EQ_SY, 	] as const, () => OP.EQ),
	Rule([NE_SY		] as const, () => OP.NE),
	Rule(['&', 		] as const, () => OP.AND),
	Rule(['^', 		] as const, () => OP.XOR),
	Rule(['|', 		] as const, () => OP.OR),
	Rule([AND_SY, 	] as const, () => OP.BAND),
	Rule([OR_SY		] as const, () => OP.BOR),
	Rule(['(', ')'	] as const, () => OP.FUN_CALL),
	Rule(['[', ']'	] as const, () => OP.ARRAY_INDEX),
);

const _abstract_declarator = Rules<any>(
	Rule([/*, empty, */] as const, ($, cg) => NewDeclNode(cg.tokenLoc, 0, cg.type_specs)),
	Rule([abstract_declarator, '[', constant_expression, ']'] as const, ($, cg) => Array_Declarator(cg, $[0], $[2], 0)),
	Rule([abstract_declarator, '[', ']'] as const, ($, cg) => Array_Declarator(cg, $[0], 0 , 1)),
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
);

const _parameter_list = Rules<any>(
	Rule([parameter_declaration] as const, $ => $[0]),
	Rule([parameter_list, ',', parameter_declaration] as const, $ => AddDecl($[0], $[2])),
);

const _parameter_declaration = Rules<any>(
	Rule([attribute, parameter_declaration] as const, $ => AddDeclAttribute($[1], $[0])),
	Rule([declaration_specifiers, declarator] as const, ($, cg) => Param_Init_Declarator(cg, $[1], NULL)),
	Rule([declaration_specifiers, declarator, '=', initializer] as const, ($, cg) => Param_Init_Declarator(cg, $[1], $[3])),
);

const _abstract_parameter_list = Rules<any>(
	Rule([/*, empty, */] as const, () => NULL),
	Rule([non_empty_abstract_parameter_list] as const),
);

const _non_empty_abstract_parameter_list = Rules<any>(
	Rule([abstract_declaration] as const, ($, cg) => {
		if (IsVoid($[0].type.type))
			cg.current_scope.flags |= Scope.has_void_param;
		return $[0];
	}),
	Rule([non_empty_abstract_parameter_list, ',', abstract_declaration] as const, ($, cg) => {
		if ((cg.current_scope.flags & Scope.has_void_param) || IsVoid($[0].type.type))
			SemanticError(cg, cg.tokenLoc, ERROR___VOIDOT_ONLY_PARAM);
		return AddDecl($[0], $[2]);
	}),
);

/******************/
/* Initialization */
/******************/

const _initializer = Rules<any>(
	Rule([expression] as const, ($, cg) => Initializer(cg, $[0])),
	Rule(['{', initializer_list, '}'] as const, ($, cg) => Initializer(cg, $[1])),
	Rule(['{', initializer_list, ',', '}'] as const, ($, cg) => Initializer(cg, $[1])),
	Rule([SAMPLERSTATE_SY, '{', state_list, '}'] as const, $ => $[2]),
);

const _initializer_list = Rules<any>(
	Rule([initializer] as const, $ => InitializerList($[0], NULL)),
	Rule([initializer_list, ',', initializer] as const, $ => InitializerList($[0], $[2])),
);

const _state_list = Rules<any>(
	Rule([state, ';'] as const, $ => InitializerList($[0], NULL)),
	Rule([state_list, state, ';'] as const, $ => InitializerList($[0], $[1])),
);

const _state = Rules<any>(
	Rule([identifier, '=', state_value] as const, ($, cg) => StateInitializer(cg, $[0], $[2])),
	Rule([TYPEIDENT_SY, '=', state_value] as const, ($, cg) => StateInitializer(cg, $[0], $[2])),
);

const _state_value = Rules<any>(
	Rule([identifier] as const, ($, cg) => SymbolicConstant(cg, $[0], 0)),
	Rule([constant] as const),
	Rule(['<', additive_expression, '>'] as const, $ => $[1]),
);
/***************/
/* EXPRESSIONS */
/***************/

/************/
/* Variable */
/************/

const _variable = Rules<any>(
	Rule([basic_variable] as const, $ => $[0]),
	Rule([scope_identifier, COLONCOLON_SY, basic_variable] as const, $ => $[2]),
);

const _basic_variable = Rules<any>(
	Rule([variable_identifier] as const, ($, cg) => BasicVariable(cg, $[0])),
);

/**********************/
/* Primary Expression */
/**********************/

const _primary_expression = Rules<any>(
	Rule([variable] as const),
	Rule([constant] as const),
	Rule(['(', expression, ')'] as const, $ => $[1]),
	Rule([type_specifier, '(', expression_list, ')'] as const, ($, cg) => NewConstructor(cg, cg.tokenLoc, $[0], $[2])),
);

/*********************/
/* Postfix Operators */
/*********************/

const _postfix_expression = Rules<any>(
	Rule([primary_expression] as const),
	Rule([postfix_expression, PLUSPLUS_SY] as const, ($, cg) => NewUnopNode(cg, OP.POSTINC, $[0])),
	Rule([postfix_expression, MINUSMINUS_SY] as const, ($, cg) => NewUnopNode(cg, OP.POSTDEC, $[0])),
	Rule([postfix_expression, '.', member_identifier] as const, ($, cg) => NewMemberSelectorOrSwizzleOrWriteMaskOperator(cg, cg.tokenLoc, $[0], $[2])),
	Rule([postfix_expression, '[', expression, ']'] as const, ($, cg) => NewIndexOperator(cg, cg.tokenLoc, $[0], $[2])),
	Rule([postfix_expression, '(', actual_argument_list, ')'] as const, ($, cg) => NewFunctionCallOperator(cg, cg.tokenLoc, $[0], $[2])),
);

const _actual_argument_list = Rules<any>(
	Rule([/*, empty, */] as const, () => NULL),
	Rule([non_empty_argument_list] as const),
);

const _non_empty_argument_list = Rules<any>(
	Rule([expression] as const, ($, cg) => ArgumentList(cg, NULL, $[0])),
	Rule([non_empty_argument_list, ',', expression] as const, ($, cg) => ArgumentList(cg, $[0], $[2])),
);

const _expression_list = Rules<any>(
	Rule([expression] as const, ($, cg) => ExpressionList(cg, NULL, $[0])),
	Rule([expression_list, ',', expression] as const, ($, cg) => ExpressionList(cg, $[0], $[2])),
);

/*******************/
/* Unary Operators */
/*******************/

const _unary_expression = Rules<any>(
	Rule([postfix_expression] as const),
	Rule([PLUSPLUS_SY, unary_expression] as const, ($, cg) => NewUnopNode(cg, OP.PREINC, $[1])),
	Rule([MINUSMINUS_SY, unary_expression] as const, ($, cg) => NewUnopNode(cg, OP.PREDEC, $[1])),
	Rule(['+', unary_expression] as const, ($, cg) => NewUnaryOperator(cg, cg.tokenLoc, OP.POS, '+', $[1], 0)),
	Rule(['-', unary_expression] as const, ($, cg) => NewUnaryOperator(cg, cg.tokenLoc, OP.NEG, '-', $[1], 0)),
	Rule(['!', unary_expression] as const, ($, cg) => NewUnaryOperator(cg, cg.tokenLoc, OP.BNOT, '!', $[1], 0)),
	Rule(['~', unary_expression] as const, ($, cg) => NewUnaryOperator(cg, cg.tokenLoc, OP.NOT, '~', $[1], 1)),
);

/*****************/
/* Cast Operator */
/*****************/

const _cast_expression = Rules<any>(
	Rule([unary_expression] as const),
/* *** reduce/reduce conflict: (var-ident) (type-ident) ***
	Rule(['(', type_name, ')', cast_expression] as const),
*/
	Rule(['(', abstract_declaration, ')', cast_expression] as const, ($, cg) => NewCastOperator(cg, cg.tokenLoc, $[3], GetTypePointer(cg, $[1].loc, $[1].type))),
);

/****************************/
/* Multiplicative Operators */
/****************************/

const _multiplicative_expression = Rules<any>(
	Rule([cast_expression] as const),
	Rule([multiplicative_expression, '*', cast_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.MUL, '*', $[0], $[2], 0)),
	Rule([multiplicative_expression, '/', cast_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.DIV, '/', $[0], $[2], 0)),
	Rule([multiplicative_expression, '%', cast_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.MOD, '%', $[0], $[2], 1)),
);

/**********************/
/* Addative Operators */
/**********************/

const _additive_expression = Rules<any>(
	Rule([multiplicative_expression] as const),
	Rule([additive_expression, '+', multiplicative_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.ADD, '+', $[0], $[2], 0)),
	Rule([additive_expression, '-', multiplicative_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.SUB, '-', $[0], $[2], 0)),
);

/***************************/
/* Bitwise Shift Operators */
/***************************/

const _shift_expression = Rules<any>(
	Rule([additive_expression] as const),
	Rule([shift_expression, LL_SY, additive_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.SHL, LL_SY, $[0], $[2], 1)),
	Rule([shift_expression, GG_SY, additive_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.SHR, GG_SY, $[0], $[2], 1)),
);

/************************/
/* Relational Operators */
/************************/

const _relational_expression = Rules<any>(
	Rule([shift_expression] as const),
	Rule([relational_expression, '<', shift_expression] as const, ($, cg) => NewBinaryComparisonOperator(cg, cg.tokenLoc, OP.LT, '<', $[0], $[2])),
	Rule([relational_expression, '>', shift_expression] as const, ($, cg) => NewBinaryComparisonOperator(cg, cg.tokenLoc, OP.GT, '>', $[0], $[2])),
	Rule([relational_expression, LE_SY, shift_expression] as const, ($, cg) => NewBinaryComparisonOperator(cg, cg.tokenLoc, OP.LE, LE_SY, $[0], $[2])),
	Rule([relational_expression, GE_SY, shift_expression] as const, ($, cg) => NewBinaryComparisonOperator(cg, cg.tokenLoc, OP.GE, GE_SY, $[0], $[2])),
);

/**********************/
/* Equality Operators */
/**********************/

const _equality_expression = Rules<any>(
	Rule([relational_expression] as const),
	Rule([equality_expression, EQ_SY, relational_expression] as const, ($, cg) => NewBinaryComparisonOperator(cg, cg.tokenLoc, OP.EQ, EQ_SY, $[0], $[2])),
	Rule([equality_expression, NE_SY, relational_expression] as const, ($, cg) => NewBinaryComparisonOperator(cg, cg.tokenLoc, OP.NE, NE_SY, $[0], $[2])),
);

/************************/
/* Bitwise AND Operator */
/************************/

const _AND_expression = Rules<any>(
	Rule([equality_expression] as const),
	Rule([AND_expression, '&', equality_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.AND, '&', $[0], $[2], 1)),
);

/*********************************/
/* Bitwise Exclusive OR Operator */
/*********************************/

const _exclusive_OR_expression = Rules<any>(
	Rule([AND_expression] as const),
	Rule([exclusive_OR_expression, '^', AND_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.XOR, '^', $[0], $[2], 1)),
);

/*********************************/
/* Bitwise Inclusive OR Operator */
/*********************************/

const _inclusive_OR_expression = Rules<any>(
	Rule([exclusive_OR_expression] as const),
	Rule([inclusive_OR_expression, '|', exclusive_OR_expression] as const, ($, cg) => NewBinaryOperator(cg, cg.tokenLoc, OP.OR, '|', $[0], $[2], 1)),
);

/************************/
/* Logical AND Operator */
/************************/

const _logical_AND_expression = Rules<any>(
	Rule([inclusive_OR_expression] as const),
	Rule([logical_AND_expression, AND_SY, inclusive_OR_expression] as const, ($, cg) => NewBinaryBooleanOperator(cg, cg.tokenLoc, OP.BAND, AND_SY, $[0], $[2])),
);

/***********************/
/* Logical OR Operator */
/***********************/

const _logical_OR_expression = Rules<any>(
	Rule([logical_AND_expression] as const),
	Rule([logical_OR_expression, OR_SY, logical_AND_expression] as const, ($, cg) => NewBinaryBooleanOperator(cg, cg.tokenLoc, OP.BOR, OR_SY, $[0], $[2])),
);

/************************/
/* Conditional Operator */
/************************/

const _conditional_expression = Rules<any>(
	Rule([logical_OR_expression] as const),
	Rule([conditional_test, '?', expression, ':', conditional_expression] as const, ($, cg) => NewConditionalOperator(cg, cg.tokenLoc, $[0], $[2], $[4])),
);

const _conditional_test = Rules<any>(
	Rule([logical_OR_expression] as const, ($, cg) => CheckBooleanExpr(cg, cg.tokenLoc, $[0]).result),
);

/***********************/
/* Assignment operator */
/***********************/

const _expression = Rules<any>(
	Rule([conditional_expression] as const),
/***
	Rule([basic_variable, '=', expression] as const, ($, cg) => NewBinopNode(cg, OP.ASSIGN, $[0], $[2])),
***/
);

/***********************/
/* Function Definition */
/***********************/

const _function_definition = Rules<any>(
	Rule([function_definition_header, block_item_list, '}'] as const, ($, cg) => { DefineFunction(cg, $[0], $[1]); cg.PopScope(); }),
	Rule([function_definition_header, '}'] as const, ($, cg) => { DefineFunction(cg, $[0], NULL); cg.PopScope(); }),
);

const _function_definition_header = Rules<any>(
	Rule([attribute, function_definition_header], $ => AddDeclAttribute($[1], $[0])),
	Rule([declaration_specifiers, declarator, '{'] as const, ($, cg) => Function_Definition_Header(cg, $[1])),
);

/*************/
/* Statement */
/*************/

const _statement = Rules<any>(
	Rule([attribute, statement] as const, $ => AddStmtAttribute($[1], $[0])),
	Rule([balanced_statement] as const),
	Rule([dangling_statement] as const),
);

const _balanced_statement = Rules<any>(
	Rule([compound_statement] as const),
	Rule([discard_statement] as const),
	Rule([expression_statement] as const),
	Rule([iteration_statement] as const),
	Rule([if_statement] as const),
	Rule([switch_statement] as const),
	Rule([break_statement] as const),
	Rule([return_statement] as const),
	Rule([asm_statement] as const),
);

const _dangling_statement = Rules<any>(
	Rule([dangling_if] as const),
	Rule([dangling_iteration] as const),
);

/**********************/
/* Assembly Statement */
/**********************/

const _asm_statement = Rules<any>(
	Rule([ASM_SY, '{', assembly, '}'] as const, $ => $[2]),
);
/*********************/
/* Discard Statement */
/*********************/

const _discard_statement = Rules<any>(
	Rule([DISCARD_SY, ';'] as const, ($, cg) => NewDiscardStmt(cg.tokenLoc, NewUnopSubNode(cg, OP.KILL, SUBOP_V(0, TYPE.BASE_BOOLEAN), NULL))),
	Rule([DISCARD_SY, expression, ';'] as const, ($, cg) => {
		const {result, len} = CheckBooleanExpr(cg, cg.tokenLoc, $[1]);
		return NewDiscardStmt(cg.tokenLoc, NewUnopSubNode(cg, OP.KILL, SUBOP_V(len, TYPE.BASE_BOOLEAN), result));
	}),
);
/****************/
/* Break Statement */
/****************/
const _break_statement = Rules<any>(
	Rule([BREAK_SY, ';'] as const, ($, cg) => NewBreakStmt(cg.tokenLoc)),
);

/****************/
/* If Statement */
/****************/

const _if_statement = Rules<any>(
	Rule([if_header, balanced_statement, ELSE_SY, balanced_statement] as const, $ => SetThenElseStmts($[0], $[1], $[3])),
);

const _dangling_if = Rules<any>(
	Rule([if_header, statement] as const, $ => SetThenElseStmts($[0], $[1], NULL)),
	Rule([if_header, balanced_statement, ELSE_SY, dangling_statement] as const, $ => SetThenElseStmts($[0], $[1], $[3])),
);

const _if_header = Rules<any>(
	Rule([IF_SY, '(', boolean_scalar_expression, ')'] as const, ($, cg) => NewIfStmt(cg.tokenLoc, $[2], NULL, NULL) ),
);

/****************/
/* Switch Statement */
/****************/

const _switch_statement = Rules<any>(
	Rule([SWITCH_SY, '(', expression, ')', compound_header, switch_item_list, compound_tail] as const, ($, cg) => NewSwitchStmt(cg.tokenLoc, $[2], $[5], cg.popped_scope)),
);

const _labeled_statement = Rules<any>(
	Rule([CASE_SY, constant_expression, ':', statement] as const, $ => $[3]),
	Rule([DEFAULT_SY, ':', statement] as const, $ => $[2]),
);

const _switch_item_list = Rules<any>(
	Rule([labeled_statement] as const),
	Rule([switch_item_list, labeled_statement] as const, $ => AddStmt($[0], $[1])),
);

/**********************/
/* Compound Statement */
/**********************/

const _compound_statement = Rules<any>(
	Rule([compound_header, block_item_list, compound_tail] as const, ($, cg) => NewBlockStmt(cg.tokenLoc, $[1], cg.popped_scope)),
	Rule([compound_header, compound_tail] as const, () => NULL),
);

const _compound_header = Rules<any>(
	Rule(['{'] as const, ($, cg) => { cg.PushScope(); cg.current_scope.funindex = cg.func_index; }),
);

const _compound_tail = Rules<any>(
	Rule(['}'] as const, ($, cg) => {
		if (cg.opts & cgclib.DUMP_PARSETREE)
			PrintScopeDeclarations(cg);
		cg.PopScope();
	})
);

const _block_item_list = Rules<any>(
	Rule([block_item] as const),
	Rule([block_item_list, block_item] as const, $ => AddStmt($[0], $[1])),
);

const _block_item = Rules<any>(
	Rule([declaration] as const),
	Rule([statement] as const, $ => CheckStmt($[0])),
);

/************************/
/* Expression Stetement */
/************************/

const _expression_statement = Rules<any>(
	Rule([expression_statement2, ';'] as const),
	Rule([';'] as const, () => NULL),
);

const _expression_statement2 = Rules<any>(
	Rule([postfix_expression, /* basic_variable */ '=', expression] as const, ($, cg) => NewSimpleAssignmentStmt(cg, cg.tokenLoc, $[0], $[2], 0)),
	Rule([expression] as const, ($, cg) => NewExprStmt(cg.tokenLoc, $[0])),
	Rule([postfix_expression, ASSIGNMINUS_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNMINUS, $[0], $[2])),
	Rule([postfix_expression, ASSIGNMOD_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNMOD, $[0], $[2])),
	Rule([postfix_expression, ASSIGNPLUS_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNPLUS, $[0], $[2])),
	Rule([postfix_expression, ASSIGNSLASH_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNSLASH, $[0], $[2])),
	Rule([postfix_expression, ASSIGNSTAR_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNSTAR, $[0], $[2])),
	Rule([postfix_expression, ASSIGNAND_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNAND, $[0], $[2])),
	Rule([postfix_expression, ASSIGNOR_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNOR, $[0], $[2])),
	Rule([postfix_expression, ASSIGNXOR_SY, expression] as const, ($, cg) => NewCompoundAssignmentStmt(cg, cg.tokenLoc, OP.ASSIGNXOR, $[0], $[2])),
);

/***********************/
/* Iteration Statement */
/***********************/

const _iteration_statement = Rules<any>(
	Rule([WHILE_SY, '(', boolean_scalar_expression, ')', balanced_statement] as const, ($, cg) => NewWhileStmt(cg.tokenLoc, STMT.WHILE, $[2], $[4])),
	Rule([DO_SY, statement, WHILE_SY, '(', boolean_scalar_expression, ')', ';'] as const, ($, cg) => NewWhileStmt(cg.tokenLoc, STMT.DO, $[4], $[1])),
	Rule([FOR_SY, '(', for_expression_init, ';', boolean_expression_opt, ';', for_expression_opt, ')', balanced_statement] as const, ($, cg) => NewForStmt(cg.tokenLoc, $[2], $[4], $[6], $[8])),
);

const _dangling_iteration = Rules<any>(
	Rule([WHILE_SY, '(', boolean_scalar_expression, ')', dangling_statement] as const, ($, cg) => NewWhileStmt(cg.tokenLoc, STMT.WHILE, $[2], $[4])),
	Rule([FOR_SY, '(', for_expression_init, ';', boolean_expression_opt, ';', for_expression_opt, ')', dangling_statement] as const, ($, cg) => NewForStmt(cg.tokenLoc, $[2], $[4], $[6], $[8])),
);

const _boolean_scalar_expression = Rules<any>(
	Rule([expression] as const, ($, cg) => CheckBooleanExpr(cg, cg.tokenLoc, $[0], NULL))
);

const _for_expression_opt = Rules<any>(
	Rule([for_expression] as const),
	Rule([/*, empty, */] as const, () => NULL),
);

const _for_expression = Rules<any>(
	Rule([expression_statement2] as const),
	Rule([for_expression, ',', expression_statement2] as const, $ => {
		if ($[0]) {
			let lstmt = $[0];
			while (lstmt.next)
				lstmt = lstmt.next;
			lstmt.next = $[2];
			return $[0];
		} else {
			return $[2];
		}
	})
);

const _for_expression_init = Rules<any>(
	Rule([declaration_specifiers, init_declarator_list] as const, $ => $[1]),
	Rule([for_expression_opt] as const),
);

const _boolean_expression_opt = Rules<any>(
	Rule([boolean_scalar_expression] as const),
	Rule([/*, empty, */] as const, () => NULL),
);

/*******************/
/*Return Statement */
/*******************/

const _return_statement = Rules<any>(
	Rule([RETURN_SY, expression, ';'] as const, ($, cg) => NewReturnStmt(cg, cg.tokenLoc, cg.current_scope, $[1])),
	Rule([RETURN_SY, ';'] as const, ($, cg) => NewReturnStmt(cg, cg.tokenLoc, cg.current_scope, NULL)),
);

/*********/
/* Misc. */
/*********/

const _member_identifier = Rules<any>(
	Rule([identifier] as const),
);

const _scope_identifier = Rules<any>(
	Rule([identifier] as const),
);

const _semantics_identifier = Rules<any>(
	Rule([identifier] as const),
);

const _variable_identifier = Rules<any>(
	Rule([identifier] as const),
);

const _identifier = Rules<any>(
	Rule([IDENT_SY] as const),
);

const _constant = Rules<any>(
	Rule([INTCONST_SY, /*, Temporary!, */] as const, 	($, cg) => NewIConstNode(cg, OP.ICONST, $[0], TYPE.BASE_CINT)),
	Rule([UINTCONST_SY, /*, Temporary!, */] as const, 	($, cg) => NewIConstNode(cg, OP.ICONST, $[0], TYPE.BASE_CINT)),
	Rule([CFLOATCONST_SY, /*, Temporary!, */] as const, ($, cg) => NewFConstNode(cg, OP.FCONST, $[0], cg.GetFloatSuffixBase(' '))),
	Rule([FLOATCONST_SY, /*, Temporary!, */] as const, 	($, cg) => NewFConstNode(cg, OP.FCONST, $[0], cg.GetFloatSuffixBase('f'))),
	Rule([FLOATHCONST_SY, /*, Temporary!, */] as const, ($, cg) => NewFConstNode(cg, OP.FCONST, $[0], cg.GetFloatSuffixBase('h'))),
	Rule([FLOATXCONST_SY, /*, Temporary!, */] as const, ($, cg) => NewFConstNode(cg, OP.FCONST, $[0], cg.GetFloatSuffixBase('x'))),
	Rule([STRCONST_SY, /*, Temporary!, */] as const, ($, cg) => NewIConstNode(cg, OP.ICONST, $[0], TYPE.BASE_STRING)),
);

const _constant_expression = Rules<any>(
	Rule([expression] as const, ($, cg) => GetConstant(cg, $[0], 0)),
);

const parser = tison({
	start: _compilation_unit,
	skip: [/\s+/]
});