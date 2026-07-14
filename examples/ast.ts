
// --- AST types ---

export interface TemplatePart { str: string; exp?: Expr; }

export type Literal =
    | { type: 'literal'; value: number | string | boolean | null | TemplatePart[] }
    | { type: 'regex'; pattern: string; flags: string }
    | { type: 'bigint'; value: string };	// because bigint can't round-trip through JSON.stringify

export type Key = string | { computed: Expr };

export type ObjectProperty =
    | { key: Key; value: Expr; kind: 'init' | 'get' | 'set' }
    | { kind: 'spread'; argument: Expr };

// Destructuring binding targets, shared by variable declarations, for-loop left-hand sides, and function parameters.
export type BindingTarget = string | ObjectPattern | ArrayPattern;
export interface ObjectPatternProperty  { key: string; value: BindingTarget; default?: Expr; }
export interface ObjectPattern          { type: 'object_pattern'; properties: ObjectPatternProperty[]; rest?: string; }
export interface ArrayPatternElement    { target: BindingTarget; default?: Expr; }
export interface ArrayPattern           { type: 'array_pattern'; elements: (ArrayPatternElement | undefined)[]; rest?: string; }

export type Param = string | { target: BindingTarget; default?: Expr; typeAnnotation?: unknown; optional?: boolean; modifiers?: string[] };
export interface ParamList { params: Param[]; rest?: string; restType?: unknown; }

export type Expr =
    | Literal
    | { type: 'identifier'; name: string; }
    | { type: 'this' }
    | { type: 'array'; elements: readonly (Expr | undefined)[] }	// `undefined` entries are holes (elisions), e.g. the gaps in `[1, , 3]`.
    | { type: 'object'; properties: readonly ObjectProperty[] }
    | { type: 'function'; name?: string; params: Param[]; rest?: string; restType?: unknown; body: Statement[]; generator?: boolean; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
    | { type: 'member'; object: Expr; property: string; optional?: boolean }
    | { type: 'index'; object: Expr; property: Expr; optional?: boolean }
    | { type: 'call'; callee: Expr; arguments: Expr[]; optional?: boolean; typeArgs?: unknown[] }
    | { type: 'new'; callee: Expr; arguments: Expr[]; typeArgs?: unknown[] }
    | { type: 'unary'; operator: string; argument: Expr; prefix: boolean }
    | { type: 'update'; operator: string; argument: Expr; prefix: boolean }
    | { type: 'binary'; operator: string; left: Expr; right: Expr }
    | { type: 'logical'; operator: string; left: Expr; right: Expr }
    | { type: 'assign'; operator: string; left: Expr; right: Expr }
    | { type: 'conditional'; test: Expr; consequent: Expr; alternate: Expr }
    | { type: 'sequence'; expressions: Expr[] }
    | { type: 'spread'; argument: Expr }	// `...x` inside an array literal or a call's argument list.
    | { type: 'tagged_template'; tag: Expr; quasi: TemplatePart[] }
    | { type: 'arrow'; params: Param[]; rest?: string; restType?: unknown; body: Expr | Statement[]; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
    | { type: 'yield'; argument?: Expr; delegate?: boolean }	// `delegate` is `yield*`; this grammar doesn't enforce that `yield` only appears inside a generator body
    | { type: 'class'; name?: string; superClass?: Expr; body: ClassMember[]; typeParams?: unknown[]; implementsClause?: unknown[]; abstract?: boolean }
    | { type: 'await'; argument: Expr }
    | { type: 'as_expression'; expression: Expr; typeAnnotation: unknown }
    | { type: 'satisfies_expression'; expression: Expr; typeAnnotation: unknown }
    | { type: 'non_null'; expression: Expr };

export interface VarDeclarator { name: BindingTarget; init?: Expr; typeAnnotation?: unknown; definite?: boolean; }
export interface SwitchCase { test?: Expr; consequent: Statement[]; }

export type DeclarationKind = 'var'|'let'|'const';
export type ForInit = Expr | { type: 'var'; kind: DeclarationKind; declarations: VarDeclarator[] };

export interface ImportSpecifier { imported: string; local: string; typeOnly?: boolean; }
export interface ExportSpecifier { local: string; exported: string; typeOnly?: boolean; }

export type ClassMember =
    | { type: 'method'; kind: 'method' | 'get' | 'set'; key: string | { computed: Expr }; value: Expr; modifiers?: string[]; optional?: boolean }
    | { type: 'field'; key: string | { computed: Expr }; value?: Expr; modifiers?: string[]; optional?: boolean; typeAnnotation?: unknown; definite?: boolean }

export type Statement =
    | { type: 'block'; body: Statement[] }
    | { type: 'var'; kind: DeclarationKind; declarations: VarDeclarator[] }
    | { type: 'expression'; expression: Expr }
    | { type: 'empty' }
    | { type: 'if'; test: Expr; consequent: Statement; alternate?: Statement }
    | { type: 'do_while'; body: Statement; test: Expr }
    | { type: 'while'; test: Expr; body: Statement }
    | { type: 'for'; init?: ForInit; test?: Expr; update?: Expr; body: Statement }
    | { type: 'for_in'; kind: 'in' | 'of'; left: ForInit; right: Expr; body: Statement }
    | { type: 'continue'; label?: string }
    | { type: 'break'; label?: string }
    | { type: 'return'; argument?: Expr }
    | { type: 'with'; argument: Expr; body: Statement }
    | { type: 'labeled'; label: string; body: Statement }
    | { type: 'switch'; discriminant: Expr; cases: SwitchCase[] }
    | { type: 'throw'; argument: Expr }
    | { type: 'try'; block: Statement[]; handlerParam?: string; handlerBody?: Statement[]; finalizer?: Statement[] }
    | { type: 'debugger' }
    | { type: 'function_decl'; name: string; params: Param[]; rest?: string; restType?: unknown; body?: Statement[]; generator?: boolean; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
    | { type: 'import'; default?: string; namespace?: string; specifiers?: ImportSpecifier[]; source: string; typeOnly?: boolean }
    | { type: 'export'; specifiers: ExportSpecifier[]; source?: string; typeOnly?: boolean }
    | { type: 'export_all'; source: string; exported?: string }
    | { type: 'export_default'; declaration: Expr | Statement }
    | { type: 'export_decl'; declaration: Statement }
    | { type: 'class_decl'; name: string; superClass?: Expr; body: ClassMember[]; typeParams?: unknown[]; implementsClause?: unknown[]; abstract?: boolean };

export interface Program { type: 'program'; body: Statement[]; }
