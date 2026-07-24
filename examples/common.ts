export interface Literal<T> { type: 'literal'; value: T }
export function  Literal<T>(value: T): Literal<T> { return { type: 'literal', value }; }

export interface Identifier {type: 'identifier', name: string}
export function  Identifier(name: string) { return {type: 'identifier', name} as const; }

export interface Unary<E, O>		{ type: 'unary'; operator: O; operand: E };
export function  Unary<E, const O>(operator: O, operand: E): Unary<E, O> { return { type: 'unary', operator, operand}; }
export interface UnaryPost<E, O>	{ type: 'unary_post'; operator: O, operand: E }
export function  UnaryPost<E, const O>(operator: O, operand: E): UnaryPost<E, O> { return { type: 'unary_post', operator, operand}; }

export interface Binary<E, O> { type: 'binary'; operator: O; left: E; right: E }
export function  Binary<E, const O>(operator: O, left: E, right: E): Binary<E, O> { return { type: 'binary', operator, left, right}; }


export function mergeMods(a?: string[], b?: string[]): string[] | undefined {
    if (a || b)
        return [...(a ?? []), ...(b ?? [])];
}
