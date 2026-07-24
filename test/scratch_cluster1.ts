type Expr = { type: 'lit'; value: number } | { type: 'bin'; left: Expr; right: Expr };

type Statement<T> =
	| { type: 'block'; body: Statement<T>[] }
	| { type: 'if'; test: Expr; consequent: Statement<T>; alternate?: Statement<T>; anno?: T }
	| { type: 'expr'; expression: Expr };

type Type = { type: 'ref'; name: string };

type TSStatement = Statement<Type>;

type NodeMap<N> = Partial<{[K in keyof N]: (x: Exclude<N[K], undefined>) => Exclude<N[K], undefined> | undefined}>;

function mapObject<N extends Record<string, any>>(node: N, fields: NodeMap<N>): N {
	const r = {...node};
	for (const f in fields) {
		const k = f as keyof N;
		if ((node as any)[k] !== undefined) {
			const ret = (fields as any)[k]?.(node[k]);
			if (ret !== undefined)
				r[k] = ret;
			else
				delete r[k];
		}
	}
	return r;
}

function mapDefined<T>(map: (x: T) => T | undefined) {
	return (x: T) => notUndefined(map(x));
}
function notUndefined<T>(x: T | undefined): T {
	if (x === undefined)
		throw new Error('undefined');
	return x;
}

const mapExpr = (e: Expr): Expr | undefined => e;

function makeStatementMapper(): (s: TSStatement) => TSStatement | undefined {
	const map = (s: TSStatement): TSStatement | undefined => s;
	return map;
}

const mapStatement = makeStatementMapper();
const mapStatementA = mapDefined(mapStatement);
// mapStatementC deliberately widens to `any`'s worth of generic instantiation, like walker.ts's real one
const mapStatementC = (stmt: TSStatement) => mapStatement(stmt) as Statement<any> | undefined;

function fixIf(stmt: TSStatement) {
	if (stmt.type === 'if') {
		return mapObject(stmt, {
			test: mapExpr,
			consequent: mapStatementA,
			alternate: mapStatementC,
		});
	}
}
