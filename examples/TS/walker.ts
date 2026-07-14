/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Expr, BindingTarget, Key, NameAndType } from './js-parser';
import { Type } from './ts-parser';

// ===================================================================
//  Type Guards
// ===================================================================

export function guard<R>(types: string[]) {
	const set = new Set(types);
	return (node: any): node is R => node && typeof node === 'object' && 'type' in node && set.has(node.type);
}

const stmts = ['block', 'var', 'expression', 'empty', 'if', 'do_while', 'while', 'for', 'for_in', 'continue', 'break', 'return', 'with', 'labeled', 'switch', 'throw', 'try', 'debugger', 'function_decl', 'import', 'export', 'export_decl', 'class_decl'];

export const isProgram 		= guard<TS.Program>(['program']);
export const isType 			= guard<Type>(['ref', 'literal', 'template_literal', 'this', 'array', 'tuple', 'union', 'intersection', 'function', 'constructor', 'object', 'parenthesized', 'keyof', 'readonly', 'typeof', 'indexed_access', 'conditional', 'infer', 'mapped', 'predicate']);
export const isTsDeclaration 	= guard<TS.Declaration>(['type_alias_decl', 'interface_decl', 'enum_decl', 'namespace_decl']);
export const isJsStatement 	= guard<JS.Statement>(stmts);
export const isTsStatement 	= guard<TS.Statement>(['declare', ...stmts]);

export function hasMod(e: {modifiers?: string[]}, m: string) {
	return e.modifiers?.includes(m);
}
export function dropMod(e: {modifiers?: string[]}, m: string) {
	if (e.modifiers?.includes(m))
		e.modifiers = e.modifiers.filter(i => i != m);
}

//-----------------------------------------------------------------------------
// TSwalker
//-----------------------------------------------------------------------------

type NodeMap<N>		= Partial<{[K in keyof N]: (x: Exclude<N[K], undefined>) => Exclude<N[K], undefined> | undefined}>
export type Preserve<U>	= <T extends U>(x: T)=>T;
type OnAST<U>		= (x: U, process: <T extends U>(x: T)=>T) => U | undefined;

function processArrays<T>(process: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] | undefined => {
		const result = x.map(process).filter(i => !!i) as T[] ?? [];
		return result.length > 0 ? result : undefined;
	};
}

function processArraysA<T>(process: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] => x.map(process).filter(i => !!i) as T[] ?? [];
}

function processArraysQ<T>(process: (x: T) => T) {
	return (x: readonly (T | undefined)[]): (T | undefined)[] => x.map(e => e !== undefined ? process(e) : undefined);
}

function processDefined<T>(process: (x: T) => T | undefined) {
	return (x: T) => notUndefined(process(x));
}

function notUndefined<T>(x: T | undefined): T {
	if (x === undefined)
		throw new Error('processor returned undefined');
	return x;
}


function mapObject<N extends Record<string, any>>(node: N, fields: NodeMap<N>): N {
	const r = {...node};
	for (const f in fields) {
		const k = f as keyof N;
		if (node[k] !== undefined) {
			const ret = fields[k]?.(node[k]);
			if (ret !== undefined)
				r[k] = ret;
			else
				delete r[k];
		}
	}
	return r;
}

function mapObjectVoid<N extends Record<string, any>>(node: N, fields: NodeMap<N>): N {
	for (const f in fields) {
		const k = f as keyof N;
		if (node[k] !== undefined)
			fields[k]?.(node[k]);
	}
	return node;
}



export function TSwalk<T extends TS.Program | TS.Statement | Expr | Type | TS.Statement[]>(ast: T,
	onStatement?:	OnAST<TS.Statement>,
	onExpression?:	OnAST<Expr>,
	onType?:		OnAST<Type>,
	mapper			= mapObject
): T | undefined {

	const processStatement = (stmt: TS.Statement) =>
		onStatement ? onStatement(stmt, _Statement as Preserve<TS.Statement>) : _Statement(stmt);

	const processExpression = <T extends Expr>(expr: T) =>
		onExpression ? onExpression(expr, _Expression as Preserve<Expr>) as T : expr;//_Expression(expr);

	const processType = (type: Type) =>
		onType ? onType(type, _Type as Preserve<Type>) : type;//_Type(type);


	// with conversion to TS.Statement
	const processStatementC = (stmt: TS.Statement) =>
		processStatement(stmt) as JS.Statement | undefined;

	// with conversion to TS.Statement and must be defined
	const processStatementCA = (stmt: TS.Statement) =>
		notUndefined(processStatement(stmt)) as JS.Statement;

	const processExpressionQ = (expr: Expr|undefined) =>
		expr ? processExpression(expr) : expr;

	// must be defined
	const processExpressionA = <T extends Expr>(expr: T) =>
		notUndefined(processExpression(expr));

	// must be defined
	const processTypeA = (type: Type) =>
		notUndefined(processType(type));

	// with conversion from unknown
	const processTypeU = (type: unknown): unknown|undefined =>
		processType(type as Type);

	const processRest = (rest: NameAndType<any>): NameAndType<any> =>
		({key: rest.key, typeAnnotation: processTypeU(rest.typeAnnotation)});

	const processBlock = processArraysA(processStatementC);

	const processVarDeclarator = (x: JS.VarDeclarator) =>
		mapper(x, {
			name: processBindingTarget,
			init: processExpression,
			typeAnnotation: processTypeU
		});

	const processBindingTarget = (t: BindingTarget): BindingTarget => {
		if (typeof t === 'string')
			return t;
		if (t.type === 'object_pattern')
			return mapper(t, {
				properties: processArrays(p => mapper(p, {
				value: processBindingTarget,
				default: processExpression,
			}))});
		return mapper(t, {elements: processArrays(e => e ? mapper(e, {
			target: processBindingTarget,
			default: processExpression,
		}) : e)});
	};

	const processTSParam = (p: TS.Param) => mapper(p, {
		typeAnnotation:	processType
	});

	const processParam = (p: JS.Param<any>) => mapper(p, {
		key:			processBindingTarget,
		default:		processExpression,
		typeAnnotation:	processTypeU
	});

	const processKey = (key: Key): Key =>
		typeof key === 'string' ? key : { computed: processExpressionA(key.computed) };

	const processClassMember = (m: TS.ClassMember): JS.ClassMember => {
		switch (m.type) {
			case 'field':	return mapper(m, {key: processKey, value: processExpression, typeAnnotation: processTypeU});
			case 'method':	return mapper(m, {key: processKey, value: processExpressionA});
			case 'static_block':	return mapper(m, {body: processArraysA(processStatementC)}) as any;
			case 'method_signature':return mapper(m, {key: processKey, params: processArraysA(processParam), rest: processRest, returnType: processType, typeParams: processArraysA(processTSTypeParam)}) as any;
			case 'index_signature':	return mapper(m, {paramType: processType, typeAnnotation: processType}) as any;
		}
	};

	const processTSTypeMember = (m: TS.TypeMember): TS.TypeMember => {
		switch (m.kind) {
			case 'property':
				return mapper(m, {name: processKey, typeAnnotation: processTypeA});
			case 'method':
				return mapper(m, {
					name: processKey,
					params: processArraysA(processTSParam),
					returnType: processType,
					typeParams: processArraysA(processTSTypeParam)
				});
			case 'index':
				return mapper(m, {paramType: processTypeA, typeAnnotation: processTypeA});
			default:
				return m;
		}
	};
	const processTSTypeParam = (p: TS.TypeParam): TS.TypeParam =>
		mapper(p, {constraint: processType, default: processType});

	const _Type = (type: Type): Type => {
		switch (type.type) {
			case 'ref':					return mapper(type, {typeArgs: processArrays(processType)});
			case 'template_literal':	return mapper(type, { parts: processArrays(p => p.exp ? mapper(p, {exp: processType}) : p)});
			case 'array':				return mapper(type, {element: processTypeA});
			case 'tuple':				return mapper(type, {elements: processArrays(e =>
					e.type === 'spread'		? mapper(e, {argument: processTypeA})
					: e.type === 'optional'	? mapper(e, {element: processTypeA})
					: e.type === 'labeled'	? mapper(e, {element: processTypeA})
					: processTypeA(e))});
			case 'union':
			case 'intersection':		return mapper(type, {types: processArraysA(processTypeA)});
			case 'function':
			case 'constructor':			return mapper(type, {
					params:			processArraysA(processTSParam),
					returnType: 	processTypeA,
					typeParams: 	processArraysA(processTSTypeParam)
				});
			case 'object':				return mapper(type, {members: processArraysA(processTSTypeMember)});
			case 'parenthesized':		return mapper(type, {inner: processTypeA});
			case 'keyof':				return mapper(type, {argument: processTypeA});
			case 'readonly':			return mapper(type, {argument: processTypeA});
			case 'indexed_access':		return mapper(type, {object: processTypeA, index: processTypeA});
			case 'conditional':			return mapper(type, {
					checkType:		processTypeA,
					extendsType:	processTypeA,
					trueType:		processTypeA,
					falseType:		processTypeA
				});
			case 'infer':				return mapper(type, {constraint: processType});
			case 'mapped':				return mapper(type, {
					constraint: 	processTypeA,
					nameType:		processType,
					valueType:		processTypeA
				});
			case 'predicate':			return mapper(type, {assertedType: processTypeA});

			case 'literal':
			case 'this':
			case 'typeof':
				return type;
			case 'import':				return mapper(type, {typeArgs: processArrays(processType)});
		}
	};

	const _Expression = (expr: Expr): Expr => {
		switch (expr.type) {
			case 'literal':		return mapper(expr, {
				value: v => Array.isArray(v) ? v.map(p => p.exp ? mapper(p, {exp: processExpression}) : p) : v
			});
			case 'array':		return mapper(expr, {
				elements: processArraysQ(processExpressionA)
			});
			case 'object':		return mapper(expr, {
				properties: processArraysA(p => p.kind === 'spread'
					? mapper(p, { argument: processExpressionA})
					: mapper(p, { key: processKey, value: processExpressionA })
				)
			});
			case 'function': 	return mapper(expr, {
				params:		processArraysA(processParam),
				body:		processArraysA(processStatementC),
				typeParams: processArrays(processTypeU),
				returnType:	processTypeU,
				rest:		processRest,
			});
			case 'member':		return mapper(expr, {
				object:		processExpressionA
			});
			case 'index':		return mapper(expr, {
				object:		processExpressionA,
				property:	processExpressionA
			});
			case 'call':
			case 'new':			return mapper(expr, {
				callee:		processExpressionA,
				arguments:	processArraysA(processExpressionA),
				typeArgs:	processArrays(processTypeU)
			});
			case 'unary':
			case 'update':
			case 'spread':
			case 'await':		return mapper(expr, {
				argument: 	processExpressionA
			});
			case 'binary':
			case 'logical':
			case 'assign':		return mapper(expr, {
				left:		processExpressionA,
				right:		processExpressionA
			});
			case 'conditional':	return mapper(expr, {
				test:		processExpressionA,
				consequent: processExpressionA,
				alternate:	processExpressionA
			});
			case 'sequence':	return mapper(expr, {
				expressions: processArraysA(processExpressionA)
			});
			case 'tagged_template':	return mapper(expr, {
				tag: 			processExpressionA,
				quasi: 			processArrays(p => p.exp ? mapper(p, {exp: processExpression}) : p)
			});
			case 'arrow':		return mapper(expr, {
				params: processArraysA(processParam),
				body: (body: any) => Array.isArray(body) ? processBlock(body) : processExpressionA(body),
				typeParams:	processArrays(processTypeU),
				returnType:	processTypeU,
				rest:		processRest
			});
			case 'yield':		return mapper(expr, {argument: processExpression});
			case 'class':		return mapper(expr, {
				superClass: processExpression,
				body:		processArraysA(processClassMember),
				typeParams:	processArrays(processTypeU),
				implementsClause: processArrays(processTypeU)
			}) as Expr;
			case 'as_expression':
			case 'satisfies_expression':
			case 'non_null':	return mapper(expr, {
				expression: processExpressionA
			});
			case 'regex':
			case 'bigint':
			case 'this':
			case 'identifier':
				return expr;
		}
	};

	const processForInit = (init: JS.ForInit): JS.ForInit => init.type === 'var'
		? mapper(init, {declarations: processArrays(processVarDeclarator)})
		: processExpressionA(init);

	const _Statement = (stmt: TS.Statement): TS.Statement => {
		switch (stmt.type) {
			case 'block':		return mapper(stmt, {
				body:			processArraysA(processStatementC)
			});
			case 'var': 		return mapper(stmt, {
				declarations: 	processArrays(processVarDeclarator)
			});
			case 'expression': 	return mapper(stmt, {
				expression:		processExpressionA
			});
			case 'if':			return mapper(stmt, {
				test:			processExpressionA,
				consequent: 	processStatementCA,
				alternate:		processStatementC
			});
			case 'do_while':
			case 'while':		return mapper(stmt, {
				test:			processExpressionA,
				body:			processStatementCA
			});
			case 'for': 		return mapper(stmt, {
				init:			processForInit,
				test:			processExpression,
				update:			processExpression,
				body:			processStatementCA
			});
			case 'for_in':		return mapper(stmt, {
				left:			processForInit,
				right:			processExpressionA,
				body:			processStatementCA
			});
			case 'with':
			case 'throw':
			case 'return': 		return mapper(stmt, {
				argument:		processExpression
			});
			case 'labeled':		return mapper(stmt, {
				body:			processStatementCA
			});
			case 'switch':		return mapper(stmt, {
				discriminant:	processExpressionA,
				cases:			processArraysA(c => mapper(c, {consequent: processArraysA(processStatementC)}))
			});
			case 'try':			return mapper(stmt, {
				block:			processArraysA(processStatementC),
				handlerBody:	processArraysA(processStatementC),
				finalizer:		processArraysA(processStatementC)
			});
			case 'function_decl':	return mapper(stmt, {
				params:			processArraysA(processParam),
				body:			processArraysA(processStatementC),
				typeParams:		processArrays(processTypeU),
				returnType:		processTypeU,
				rest:			processRest,
			});
			case 'export':
				return mapper(stmt, {
					default: 	def => !def ? undefined : isTsStatement(def) ? processStatement(def) as JS.Declaration : processExpressionA(def)
				});
			case 'export_decl':		return mapper(stmt, {
				declaration:	decl => processStatement(decl) as JS.Declaration
			});
			case 'class_decl':		return mapper(stmt, {
				superClass:		processExpression,
				body:			processArrays(processClassMember),
				typeParams:		processArrays(processTypeU),
				implementsClause:	processArrays(processTypeU)
			});
			case 'type_alias_decl':	return mapper(stmt, {
				typeParams:		processArrays(processTSTypeParam),
				value: 			processType
			});
			case 'interface_decl':	return mapper(stmt,{
				typeParams:		processArrays(processTSTypeParam),
				extendsClause:	processArrays(processType),
				body:			processArrays(processTSTypeMember)
			});
			case 'enum_decl':	return mapper(stmt, {
				members:		processArraysA(m => mapper(m, {init: processExpressionQ}))
			});
			case 'namespace_decl':	return mapper(stmt, {
				body:			processArraysA(processStatement)
			});
			case 'declare':		return mapper(stmt, {
				declaration: 	decl => processStatement(decl) as JS.Declaration
			});

			default:	{ const x = stmt; return stmt; }
		}

	};

	if (Array.isArray(ast))
		return processArrays(processStatement)(ast) as T;

	if (isProgram(ast))
		return {...ast, body: processArrays(processStatement)(ast.body)};
	if (isType(ast))
		return processType(ast) as T;
	if (isTsStatement(ast) || isTsDeclaration(ast))
		return processStatement(ast) as T;
	return processExpression(ast) as T;

}
