import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as W from '../walker';
import {mapObject, mapArray, mapArrayA, mapDefined, makeProcess, makeProcessB} from '../walker';
import { Literal } from '../common';

// ===================================================================
//  Type Guards
// ===================================================================

export function guard<R>(types: string[]) {
	const set = new Set(types);
	return (node: any): node is R => node && typeof node === 'object' && 'type' in node && set.has(node.type);
}

const stmts = ['block', 'var_decl', 'expression', 'empty', 'if', 'do_while', 'while', 'for', 'for_in', 'continue', 'break', 'return', 'with', 'labeled', 'switch', 'throw', 'try', 'debugger', 'function_decl', 'import', 'export', 'export_decl', 'class_decl'];

export const isProgram			= guard<TS.Program|JS.Program<any>>(['program']);
const typeTags = guard<Type>(['ref', 'literal', 'range', 'template_literal', 'this', 'array', 'tuple', 'union', 'intersection', 'function', 'constructor', 'object', 'keyof', 'typeof', 'indexed_access', 'conditional', 'infer', 'mapped', 'predicate']);
// 'object'/'array'/'function' are real tags shared with JS.Expr's object/array-literal and function-expression
// nodes (same string, different shape: Type has members/element/no body, Expr has properties/elements/body), so
// the tag alone can't tell an object-type literal from an object-literal expression -- a field-level tiebreak can.
export const isType = (node: any): node is Type => typeTags(node) && !('properties' in node || 'elements' in node || 'body' in node);
export const isTsDeclaration	= guard<TS.Declaration>(['type_alias_decl', 'interface_decl', 'enum_decl', 'namespace_decl']);
// Tests JS statement tags but asserts the wide `TS.Statement`: since js-parser's `X` seam every JS
// statement IS one, and asserting the narrow type is what used to force casts at the call sites.
export const isJsStatement		= guard<TS.Stmt>(stmts);

type Type	= TS.Type;
type Expr	= TS.Expr;
type Stmt	= TS.Stmt;
export type Walkable0 = Stmt | Expr | Type;
export type Walkable = Stmt | Expr | Type | TS.Program | Stmt[];

//-----------------------------------------------------------------------------
// Constant folding
//-----------------------------------------------------------------------------

export function calcUnary(op: JS.unaryOps, x: any) {
	switch (op) {
		case '!':	return !x;
		case '+':	return +x;
		case '~':	return ~x;
		case '-':	return -x;
	}
}

export function calcBinary(op: JS.binaryOps, a: any, b: any) {
	switch (op) {
		case '&&':	return a && b;
		case '||':	return a || b;
		case '??':	return a ?? b;
		case '!=':	return a != b;
		case '!==':	return a !== b;
		case '==':	return a == b;
		case '===':	return a === b;
		case '<':	return a < b;
		case '<=':	return a <= b;
		case '>':	return a > b;
		case '>=':	return a >= b;
	}
	if (typeof a === 'number' && typeof b === 'number') {
		switch (op) {
			case '+':	return a + b;
			case '-':	return a - b;
			case '*':	return a * b;
			case '/':	return a / b;
			case '%':	return a % b;
			case '&':	return a & b;
			case '|':	return a | b;
			case '^':	return a ^ b;
			case '<<':	return a << b;
			case '>>':	return a >> b;
			case '>>>':	return a >>> b;
			case '**':	return a ** b;
		}
	} else if (typeof a === 'bigint' && typeof b === 'bigint') {
		switch (op) {
			case '+':	return a + b;
			case '-':	return a - b;
			case '*':	return a * b;
			case '/':	return a / b;
			case '%':	return a % b;
			case '&':	return a & b;
			case '|':	return a | b;
			case '^':	return a ^ b;
			case '<<':	return a << b;
			case '>>':	return a >> b;
			case '**':	return a ** b;
		}
	} else if (op === '+' && (typeof a === 'string' || typeof b === 'string')) {
		return a + b;
	}
}

//-----------------------------------------------------------------------------
// walk
//-----------------------------------------------------------------------------

type Recurse		= W.Recurse<Walkable0>;
type OnAST<U>		= W.OnAST<U, Recurse>;

export function walk<T extends Walkable>(ast: T,
	onStatement?:	OnAST<TS.Stmt>,
	onExpression?:	OnAST<Expr>,
	onType?:		OnAST<Type>,
	onTypeMember?:	OnAST<TS.TypeMember>,
	onClassMember?:	OnAST<TS.ClassMember>
): T | undefined {

	// The bodies still reached through a `CallSig` (a function/method/arrow body) keep js-parser's own
	// narrow `Statement<T>` -- see the `X` seam comment there. Every NESTED statement slot uses
	// `mapStatement` directly now and needs no cast.
	const mapStatementC	= (stmt: TS.Stmt) => mapStatement(stmt) as JS.Stmt<any> | undefined;
	const mapTypeU		= (type: any): any => mapType(type as Type);

	const mapKey = (key: JS.Key): JS.Key =>
		typeof key === 'string' ? key : { computed: mapExpressionA(key.computed) };

	const mapBindingTarget = (t: JS.BindingTarget): JS.BindingTarget => {
		if (typeof t === 'string')
			return t;
		if (t.type === 'object_pattern')
			return mapObject(t, {
				properties: mapArray(p => mapObject(p, {
				value: mapBindingTarget,
				default: mapExpression,
			}))});
		return mapObject(t, {elements: mapArray(e => e ? mapObject(e, {
			target: mapBindingTarget,
			default: mapExpression,
		}) : e)});
	};
	const mapTypeParam = (p: TS.TypeParam) => mapObject(p, {
		constraint:		mapType,
		default:		mapType,
	});
	const mapTypeParamU = (p: JS.TypeParam<any>) => mapTypeParam(p as TS.TypeParam) as JS.TypeParam<any>;

	const mapSig = {
		params:			mapArrayA((p: TS.Param) => mapObject(p, {
			key:			mapBindingTarget,
			default:		mapExpression,
			typeAnnotation:	mapType
		})),
		rest:			(rest: JS.Rest<Type>): JS.Rest<Type> =>	({key: rest.key, typeAnnotation: mapType(rest.typeAnnotation)}),
		typeParams:		mapArrayA(mapTypeParam),
		returnType:		(t: Type) => mapType(t),
	};
	const mapSigU = {
		params:			mapArrayA((p: JS.Param<any>) => mapObject(p, {
			key:			mapBindingTarget,
			default:		mapExpression,
			typeAnnotation:	mapTypeU
		})),
		rest:			(rest: JS.Rest<any>): JS.Rest<any> =>	({key: rest.key, typeAnnotation: mapTypeU(rest.typeAnnotation)}),
		typeParams:		mapArrayA(mapTypeParamU),
		returnType:		mapTypeU,
	};

	const mapVarDeclarator = (x: JS.Var<any>) =>
		mapObject(x, {
			name: mapBindingTarget,
			init: mapExpression,
			typeAnnotation: mapTypeU
		});

	const objectProperty = (p: JS.ObjectProperty<any>): JS.ObjectProperty<any> => {
		switch (p.type) {
			case 'spread':	return mapObject(p, { operand: mapExpressionA });
			case 'field':	return mapObject(p, { key: mapKey, value: mapExpressionA });
			default:		return mapObject(p, {...mapSigU,
				key:		mapKey,
				body:		mapArrayA(mapStatementC),
			});
		}
	};

	const classMember = (m: TS.ClassMember): TS.ClassMember => {
		switch (m.type) {
			case 'field':	return mapObject(m, {
				key:		mapKey,
				value:		mapExpression,
				typeAnnotation: mapType
			});
			case 'method':
			case 'get':
			case 'set':		return mapObject(m, {
				...mapSig,
				key:		mapKey, 
				body:		mapArrayA(mapStatementC),
			});
			case 'static_block':	return mapObject(m, {
				body: mapArrayA(mapStatementC)
			});
			case 'index_signature':	return mapObject(m, {
				paramType:	mapType,
				typeAnnotation: mapType
			});
		}
	};

	const typeMember = (m: TS.TypeMember): TS.TypeMember => {
		switch (m.type) {
			case 'property':
				return mapObject(m, {key: mapKey, typeAnnotation: mapTypeA});
			case 'method':
				return mapObject(m, {...mapSig,
					key: mapKey,
				});
			case 'call':
			case 'construct':
				return mapObject(m, mapSig);
			case 'index':
				return mapObject(m, {paramType: mapTypeA, typeAnnotation: mapTypeA});
			default:
				return m;
		}
	};

	const type = (type: Type): Type => {
		switch (type.type) {
			case 'ref':					return mapObject(type, {typeArgs: mapArray(mapType)});
			case 'typeof':
			case 'import':				return mapObject(type, {typeArgs: mapArray(mapType)});
			case 'literal':
				return Array.isArray(type.value)
					? mapObject(type as Literal<JS.TemplatePart<Type>[]>, { value: mapArray(p => p.exp ? mapObject(p, {exp: mapType}) : p)})
					: type;
			case 'array':				return mapObject(type, {element: mapTypeA});
			case 'tuple':				return mapObject(type, {elements: mapArrayA(e =>
					e.type === 'spread'		? mapObject(e, {argument: mapTypeA})
					: e.type === 'optional'	? mapObject(e, {element: mapTypeA})
					: e.type === 'labeled'	? mapObject(e, {element: mapTypeA})
					: mapTypeA(e))});
			case 'union':
			case 'intersection':		return mapObject(type, {types: mapArrayA(mapTypeA)});
			case 'function':
			case 'constructor':			return mapObject(type, mapSig);
			case 'object':				return mapObject(type, {members: mapArrayA(mapTypeMember)});
			case 'keyof':				return mapObject(type, {argument: mapTypeA});
			case 'indexed_access':		return mapObject(type, {object: mapTypeA, index: mapTypeA});
			case 'conditional':			return mapObject(type, {
					checkType:		mapTypeA,
					extendsType:	mapTypeA,
					trueType:		mapTypeA,
					falseType:		mapTypeA
				});
			case 'infer':				return mapObject(type, {constraint: mapType});
			case 'mapped':				return mapObject(type, {
					constraint: 	mapTypeA,
					nameType:		mapType,
					valueType:		mapTypeA
				});
			case 'predicate':			return mapObject(type, {assertedType: mapTypeA});

			case 'this':				return type;
			// no nested `Type` position
			case 'range':				return type;
		}
	};

	const expression = (expr: JS.Expr): JS.Expr => {
		switch (expr.type) {
			case 'literal':		return mapObject(expr, {
				value: v => Array.isArray(v) ? v.map(p => p.exp ? mapObject(p, {exp: mapExpression}) : p) : v
			});
			case 'array':		return mapObject(expr, {
				elements: x => x.map(mapExpression)//mapArray0(mapExpression)
			});
			case 'object':		return mapObject(expr, {
				properties: mapArrayA(objectProperty)
			});
			case 'function': 	return mapObject(expr, {...mapSigU,
				body:		mapArrayA(mapStatementC),
			});
			case 'member':		return mapObject(expr, {
				object:		mapExpressionA
			});
			case 'index':		return mapObject(expr, {
				object:		mapExpressionA,
				index:	mapExpressionA
			});
			case 'call':
			case 'new':			return mapObject(expr, {
				callee:		mapExpressionA,
				arguments:	mapArrayA(mapExpressionA),
				typeArgs:	mapArray(mapTypeU)
			});
			case 'spread':
			case 'unary_post':
			case 'unary':		return mapObject(expr, {
				operand: 	mapExpressionA
			});
			case 'binary':		return mapObject(expr, {
				left:		mapExpressionA,
				right:		mapExpressionA
			});
			case 'conditional':	return mapObject(expr, {
				test:		mapExpressionA,
				consequent: mapExpressionA,
				alternate:	mapExpressionA
			});
			case 'sequence':	return mapObject(expr, {
				expressions: mapArrayA(mapExpressionA)
			});
			case 'tagged_template':	return mapObject(expr, {
				tag: 			mapExpressionA,
				quasi: 			mapArray(p => p.exp ? mapObject(p, {exp: mapExpression}) : p)
			});
			case 'arrow':		return mapObject(expr, {...mapSigU,
				body: (body: any) => Array.isArray(body) ? mapArrayA(mapStatementC)(body) : mapExpressionA(body),
			});
			case 'yield':		return mapObject(expr, {operand: mapExpression});
			case 'class':		return mapObject(expr, {
				superClass: mapExpression,
				body:		mapArrayA(mapClassMemberU),
				typeParams:	mapArray(mapTypeParamU),
				implements: mapArray(mapTypeU)
			}) as JS.Expr;
			case 'instantiation':	return mapObject(expr, {
				expression: mapExpressionA,
				typeArgs:	mapArray(mapTypeU)
			});
			// The cast's own TYPE is mapped too: skipping it meant a type-rewriting walk
			// (`substituteClassTypeParam`) left `this as unknown as T[]` inside a generic class method
			// with an unsubstituted `T`, so an unannotated local initialised from it lowered to
			// `arr:ref` while the value was `arr:f64`.
			case 'as':
			case 'satisfies':
				return mapObject(expr, {
				expression: 	mapExpressionA,
				typeAnnotation:	mapTypeU
			});
			case 'jsx':	return mapObject(expr, {
				attributes:	mapArrayA(p => mapObject(p, {value: mapExpressionA})),
				children:	mapArrayA(mapExpressionA)
			});
			case 'this':
			case 'super':
			case 'identifier':
				return expr;
		}
	};

	const statement = (stmt: TS.Stmt): TS.Stmt => {
		switch (stmt.type) {
			case 'block':		return mapObject(stmt, {
				body:			mapArrayA(mapStatement)
			});
			case 'var_decl': 	return mapObject(stmt, {
				declarations: 	mapArray(mapVarDeclarator)
			});
			case 'expression': 	return mapObject(stmt, {
				expression:		mapExpressionA
			});
			case 'if':			return mapObject(stmt, {
				test:			mapExpressionA,
				consequent: 	mapStatementA,
				alternate:		mapStatement
			});
			case 'do_while':
			case 'while':		return mapObject(stmt, {
				test:			mapExpressionA,
				body:			mapStatementA
			});
			case 'for': 		return mapObject(stmt, {
				init:			init => init.type === 'var_decl'
					//? mapObject(init, {declarations: mapArray(mapVarDeclarator)})
					? mapStatement(init)
					: mapExpressionA(init),
				...(stmt.kind === 'normal' ? {
					test:			mapExpression,
					update:			mapExpression,
				} : {
					right:			mapExpressionA,
				}),
				body:			mapStatementA
			});
			case 'with':
			case 'throw':
			case 'return': 		return mapObject(stmt, {
				argument:		mapExpression
			});
			case 'labeled':		return mapObject(stmt, {
				body:			mapStatementA
			});
			case 'switch':		return mapObject(stmt, {
				discriminant:	mapExpressionA,
				cases:			mapArrayA(c => mapObject(c, {consequent: mapArrayA(mapStatement)}))
			});
			case 'try':			return mapObject(stmt, {
				body:			mapArrayA(mapStatement),
				handlers:		mapArrayA(h => mapObject(h, {body: mapArrayA(mapStatement)})),
				finalizer:		mapArrayA(mapStatement)
			});
			case 'function_decl':	return mapObject(stmt, {...mapSigU,
				body:			mapArrayA(mapStatementC),
			});
			case 'export':		return mapObject(stmt, {
				default: 		d => !d ? undefined : isJsStatement(d) ? mapStatement(d) as JS.Declaration<any> : mapExpressionA(d)
			});
			case 'export_decl':	return mapObject(stmt, {
				declaration:	d => mapStatement(d) as JS.Declaration<any>
			});
			case 'class_decl':	return mapObject(stmt, {
				superClass:		mapExpression,
				// `body` is mandatory (unlike `typeParams`/`implements`, genuinely optional) -- `mapArrayA` keeps a
				// legitimately empty class/interface body as `[]` rather than `mapArray` collapsing it to `undefined`
				// and deleting the field outright (`class Foo {}` has to stay printable).
				body:			mapArrayA(mapClassMemberU),
				typeParams:		mapArray(mapTypeParamU),
				implements:	mapArray(mapTypeU)
			});
			case 'type_alias_decl':	return mapObject(stmt, {
				typeParams:		mapArray(mapTypeParam),
				value: 			mapType
			});
			case 'interface_decl':	return mapObject(stmt,{
				typeParams:		mapArray(mapTypeParam),
				extendsClause:	mapArray(mapType),
				body:			mapArrayA(mapTypeMember)
			});
			case 'enum_decl':	return mapObject(stmt, {
				members:		mapArrayA(m => mapObject(m, {init: mapExpression}))
			});
			case 'namespace_decl':	return mapObject(stmt, {
				body:			mapArrayA(mapStatement)
			});

			default:	return stmt;
		}

	};
	const recurse: Recurse = x => {
		if (isType(x))
			return mapType(x);
		if (isJsStatement(x) || isTsDeclaration(x))
			return mapStatement(x);
		return mapExpression(x) as typeof x;
	};

	const mapStatement		= makeProcess(statement, onStatement, recurse, true);
	const mapExpression		= makeProcess(expression, onExpression, recurse, !!onType);
	const mapType			= makeProcess(type, onType, recurse);
	const mapTypeMember		= makeProcess(typeMember, onTypeMember, recurse, true);
	const mapClassMember	= makeProcess(classMember, onClassMember, recurse, true);

	const mapTypeA			= mapDefined(mapType);
	const mapExpressionA	= mapDefined(mapExpression);
	const mapStatementA		= mapDefined(mapStatement);
	const mapClassMemberU	= (m: JS.ClassMember<any>) => mapClassMember(m as TS.ClassMember) as JS.ClassMember<any>;

	if (isProgram(ast))
		return {...ast, body: mapArray(mapStatement)(ast.body)};
	if (Array.isArray(ast))
		return mapArray(mapStatement)(ast) as typeof ast;
	return recurse(ast) as T;
}

//-----------------------------------------------------------------------------
// walkB
//-----------------------------------------------------------------------------

// `kind` lets a caller that already knows what `x` is (e.g. an `if`/`while` test, always an
// expression) skip the shape-based guess below -- needed because some tags genuinely can't be
// told apart by shape alone (a 'literal' node is IDENTICAL, field for field, whether it's a
// type-level literal type or an expression-level literal value; see `recurse`'s own comment).
export type RecurseB	= (x: TS.Stmt | Expr | Type | undefined, kind?: 'expression' | 'statement' | 'type') => boolean;
type OnASTB<U>		= W.OnASTB<U, RecurseB>;

export function walkB<T extends Walkable>(ast: T,
	onStatement?:	OnASTB<TS.Stmt>,
	onExpression?:	OnASTB<JS.Expr>,
	onType?:		OnASTB<Type>,
	onTypeMember?:	OnASTB<TS.TypeMember|TS.ClassMember>,
): boolean {

	const walkKey = (key: JS.Key) => typeof key !== 'string' && walkExpression(key.computed);

	const walkBindingTarget = (t: JS.BindingTarget): boolean => {
		return typeof t === 'string' ? false
			: t.type === 'object_pattern'
			? t.properties.some(p => walkBindingTarget(p.value) || walkExpression(p.default))
			: t.elements.some(e => e && (walkBindingTarget(e.target) || walkExpression(e.default)));
	};
	const walkTypeParam = (p: TS.TypeParam) =>
		walkType(p.constraint) || walkType(p.default);

	const walkSig = (sig: TS.CallSig) => sig.params.some(p => walkBindingTarget(p.key) || walkExpression(p.default) || walkType(p.typeAnnotation))
		|| walkType(sig.rest?.typeAnnotation)
		|| walkType(sig.returnType)
		|| !!sig.typeParams?.some(walkTypeParam);


	const walkVarDeclarator = (d: JS.Var<Type>) =>
		walkBindingTarget(d.name) || walkExpression(d.init) || walkType(d.typeAnnotation);

	const objectProperty = (p: JS.ObjectProperty<any>) => {
		switch (p.type) {
		 	case 'spread':				return walkExpression(p.operand);
			case 'field':				return walkKey(p.key) || walkExpression(p.value);
			default:					return walkKey(p.key) || walkSig(p as TS.CallSig) || p.body!.some(walkStatement);
		}
	};

	const classMember = (m: TS.ClassMember) => {
		switch (m.type) {
			case 'field':				return walkKey(m.key) || walkExpression(m.value) || walkType(m.typeAnnotation);
			case 'method':
			case 'get':
			case 'set':					return walkKey(m.key) || walkSig(m) || !!m.body?.some(walkStatement);
			case 'static_block':		return m.body.some(walkStatement);
			case 'index_signature':		return walkType(m.paramType) || walkType(m.typeAnnotation);
		}
	};

	const typeMember = (m: TS.TypeMember) => {
		switch (m.type) {
			case 'property':			return walkKey(m.key) || walkType(m.typeAnnotation);
			case 'method':				return walkKey(m.key) || walkSig(m);
			case 'call':
			case 'construct':			return walkSig(m);
			case 'index':				return walkType(m.paramType) || walkType(m.typeAnnotation);
			default:					return false;
		}
	};

	const type = (t: Type): boolean => {
		switch (t.type) {
			case 'ref':
			case 'typeof':
			case 'import':				return !!t.typeArgs?.some(walkType);
			case 'literal':				return Array.isArray(t.value) && t.value.some(p => walkType(p.exp));
			case 'array':				return walkType(t.element);
			case 'tuple':				return t.elements.some(e =>
				e.type === 'spread' ? false : walkType(e.type === 'optional' || e.type === 'labeled' ? e.element : e)
			);
			case 'union':
			case 'intersection':		return t.types.some(walkType);
			case 'function':
			case 'constructor':			return walkSig(t);
			case 'object':				return t.members.some(walkTypeMember);
			case 'keyof':				return walkType(t.argument);
			case 'indexed_access':		return walkType(t.object) || walkType(t.index);
			case 'conditional':			return walkType(t.checkType) || walkType(t.extendsType) || walkType(t.trueType) || walkType(t.falseType);
			case 'infer':				return walkType(t.constraint);
			case 'mapped':				return walkType(t.constraint) || walkType(t.nameType) || walkType(t.valueType);
			case 'predicate':			return walkType(t.assertedType);
			// 'this': no nested Type position.
			default:					return false;
		}
	};
	
	const expression = (e: JS.Expr): boolean => {
		switch (e.type) {
			case 'literal':				return Array.isArray(e.value) && e.value.some(i => i.exp && walkExpression(i.exp));
			case 'array':				return e.elements.some(walkExpression);
			case 'object':				return e.properties.some(objectProperty);
			case 'function': 			return walkSig(e as TS.CallSig) || (!!e.body && e.body.some(walkStatement));
			case 'member':				return walkExpression(e.object);
			case 'index':				return walkExpression(e.object) || walkExpression(e.index);
			case 'call':
			case 'new':					return walkExpression(e.callee) || e.arguments.some(walkExpression) || (!!e.typeArgs && (e.typeArgs as Type[]).some(walkType));
			case 'spread':
			case 'unary_post':
			case 'unary':				return walkExpression(e.operand);
			case 'binary':				return walkExpression(e.left) || walkExpression(e.right);
			case 'conditional':			return walkExpression(e.test) || walkExpression(e.consequent) || walkExpression(e.alternate);
			case 'sequence':			return e.expressions.some(walkExpression);
			case 'tagged_template':		return walkExpression(e.tag) || e.quasi.some(p => walkExpression(p.exp));
			case 'arrow':				return walkSig(e as TS.CallSig) || (Array.isArray(e.body) ? e.body.some(walkStatement) : walkExpression(e.body));
			case 'yield':				return walkExpression(e.operand);
			case 'class':				return walkExpression(e.superClass) || (e.body as TS.ClassMember[]).some(walkClassMember) || !!e.implements?.some(t => walkType(t as Type));
			case 'instantiation':		return walkExpression(e.expression) || e.typeArgs.some(t => walkType(t as Type));
			case 'as':
			case 'satisfies': return walkExpression(e.expression) || walkType(e.typeAnnotation as Type);
			case 'jsx':			return e.attributes.some(p => walkExpression(p.value)) || e.children.some(walkExpression);
			case 'this':
			case 'super':
			case 'identifier':			return false;
		}
	};

	const statement = (stmt: TS.Stmt): boolean => {
		switch (stmt.type) {
			case 'block':				return stmt.body.some(walkStatement);
			case 'var_decl':			return stmt.declarations.some(walkVarDeclarator);
			case 'expression':			return walkExpression(stmt.expression);
			case 'if':					return walkExpression(stmt.test) || walkStatement(stmt.consequent) || (!!stmt.alternate && walkStatement(stmt.alternate));
			case 'do_while':
			case 'while':				return walkExpression(stmt.test) || walkStatement(stmt.body);
//			case 'for':					return (stmt.init ? (stmt.init.type === 'var_decl' ? stmt.init.declarations.some(walkVarDeclarator) : walkExpression(stmt.init)) : false)
			case 'for':					return (stmt.init ? (stmt.init.type === 'var_decl' ? walkStatement(stmt.init) : walkExpression(stmt.init)) : false)
				|| (stmt.kind === 'normal' ? (walkExpression(stmt.test) || walkExpression(stmt.update)) : walkExpression(stmt.right))
				|| walkStatement(stmt.body);
			case 'with':
			case 'throw':
			case 'return':				return walkExpression(stmt.argument);
			case 'labeled':				return walkStatement(stmt.body);
			case 'switch':				return walkExpression(stmt.discriminant)
				|| stmt.cases.some(c => walkExpression(c.test) || c.consequent.some(walkStatement));
			case 'try':					return stmt.body.some(walkStatement) || stmt.handlers.some(h => h.body.some(walkStatement)) || !!stmt.finalizer?.some(walkStatement);
			case 'function_decl':		return walkSig(stmt) || !!stmt.body?.some(walkStatement);
			case 'export':				return !!stmt.default && (isJsStatement(stmt.default) ? walkStatement(stmt.default) : walkExpression(stmt.default as JS.Expr));
			case 'export_decl':			return walkStatement(stmt.declaration);
			case 'class_decl':			return walkExpression(stmt.superClass)
				|| (stmt.body as TS.ClassMember[]).some(walkClassMember)
				|| !!stmt.typeParams?.some(t => walkTypeParam(t as TS.TypeParam))
				|| !!stmt.implements?.some(t => walkType(t as Type));
			case 'type_alias_decl':		return !!stmt.typeParams?.some(walkTypeParam) || walkType(stmt.value);
			case 'interface_decl':		return !!stmt.typeParams?.some(walkTypeParam)
				|| !!stmt.extendsClause?.some(t => walkType(t))
				|| stmt.body.some(walkTypeMember);
			case 'enum_decl':			return stmt.members.some(m => walkExpression(m.init));
			case 'namespace_decl':		return stmt.body.some(walkStatement);
			default:					return false;
		}
	};

	const recurse: RecurseB = (x, kind) => {
		if (!x)
			return false;
		if (kind === 'expression')
			return walkExpression(x as JS.Expr);
		if (kind === 'statement')
			return walkStatement(x as TS.Stmt);
		if (kind === 'type' || isType(x))
			return walkType(x as Type);
		if (isJsStatement(x) || isTsDeclaration(x))
			return walkStatement(x);
		return walkExpression(x);
	};

	const walkStatement		= makeProcessB(statement, onStatement, recurse, true);
	const walkExpression	= makeProcessB(expression, onExpression, recurse);
	const walkTypeMember 	= makeProcessB(typeMember as ((x: TS.TypeMember|TS.ClassMember) => boolean), onTypeMember, recurse, true);
	const walkClassMember 	= makeProcessB(classMember as ((x: TS.TypeMember|TS.ClassMember) => boolean), onTypeMember, recurse, true);
	const walkType			= makeProcessB(type, onType, recurse);


	if (Array.isArray(ast))
		return ast.some(walkStatement);
	if (isProgram(ast))
		return ast.body.some(walkStatement);
	if (isType(ast))
		return walkType(ast);
	if (isJsStatement(ast) || isTsDeclaration(ast))
		return walkStatement(ast);
	return walkExpression(ast);

}
