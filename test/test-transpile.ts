import * as TR from '../dist/examples/transpile';

const ts =`

class Shape {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	area(): number {
		return 0;
	}
	describe(): string {
		return \`\${this.name} has area \${this.area()}\`;
	}
}

class Circle extends Shape {
	constructor(name: string, r: number) {
		super(name);
		this.r = r;
	}
	area(): number {
		return 3.14159 * this.r ** 2;
	}
}

function classify(shapes: Shape[]): string[] {
	const out = [];
	for (const s of shapes) {
		const a = s.area();
		if (a === 0) {
			out.push(s.name + ": degenerate");
		} else if (a < 10 && a > 0) {
			out.push(s.name + ": small");
		} else {
			out.push(s.name + ": large");
		}
	}
	let i = 0;
	while (i < out.length) {
		i += 1;
	}
	for (let k = 0; k < 3; k++) {
		out.push("pad" + k);
	}
	try {
		risky();
	} catch (e) {
		out.push("failed");
	} finally {
		done();
	}
	return out;
}

const doubled = [1, 2, 3].map(x => x * 2);
const opts = { colour: "red", size: 3 };
const label = opts.colour ?? "none";

`;

const py = TR.ts2py(ts);
console.log(py);

const ts2 = TR.py2ts(py);
console.log(ts2);
