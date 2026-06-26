import {cppParser} from '../src/examples/cpp-parser';

function test(name: string, code: string) {
	try {
		console.log(name);
		console.log(JSON.stringify(cppParser.parse(code), null, 2));
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

console.log(`Grammar conflicts: ${cppParser.tables.conflicts.length}`);
for (const c of cppParser.tables.conflicts.slice(0, 20))
	console.log(c);

test('Simple class', `
class Point {
public:
	Point(int x, int y) : x(x), y(y) {}
	int getX() const { return x; }
	void setX(int v) { x = v; }
private:
	int x;
	int y;
};
`);

test('Inheritance', `
class Shape {
public:
	virtual ~Shape() {}
	virtual int area() const { return 0; }
};
class Circle : public Shape {
public:
	Circle(int r) : r(r) {}
	int area() const { return r * r; }
private:
	int r;
};
`);

test('References and new/delete', `
int main() {
	int x = 5;
	int &r = x;
	int *p = new int(10);
	delete p;
	int *arr = new int[5];
	delete[] arr;
	return 0;
}
`);

test('this, bool, nullptr', `
class Foo {
public:
	bool check() {
		return this != nullptr && flag == true;
	}
	bool flag;
};
`);

test('Namespaces and using', `
namespace math {
	int square(int x) {
		return x * x;
	}
}
using namespace math;
using std::cout;
int main() {
	return math::square(2);
}
`);

test('try/catch/throw', `
int divide(int a, int b) {
	try {
		if (b == 0)
			throw 1;
		return a / b;
	} catch (int e) {
		return -1;
	} catch (...) {
		return -2;
	}
}
`);

test('Template class and function', `
template<typename T>
class Box {
public:
	Box(T v) : value(v) {}
	T get() const { return value; }
private:
	T value;
};

template<class T>
T maxval(T a, T b) {
	return a > b ? a : b;
}
`);

test('Default parameters', `
int add(int a, int b = 5) {
	return a + b;
}
`);

test('Lambdas', `
int main() {
	auto add = [](int a, int b) { return a + b; };
	auto mul = [](int a, int b) -> int { return a * b; };
	int total = 0;
	auto accumulate = [&total](int x) mutable { total += x; };
	auto byValue = [x = 5]() { return x; };
	auto noCapture = []{ return 1; };
	return add(1, 2);
}
`);

test('Variadic template function with parameter pack', `
template<typename... Args>
int count(Args... args) {
	return sizeof...(Args);
}

int main() {
	return count(1, 2, 3);
}
`);

test('Variadic template class', `
template<class... Ts>
class Tuple {
public:
	Tuple(Ts... values) {}
};
`);

test('Pack expansion in call', `
template<typename... Args>
void forward(Args&... args) {
	target(args...);
}
`);

test('Generic type instantiation', `
class Box {};
class Pair {};
class Tuple {};
Box<int> b;
Pair<int, double> p;
Tuple<int, double, char> t;
`);

test('Nested generic type instantiation (>> splitting)', `
class vector {};
class map {};
vector<vector<int>> matrix;
vector<vector<vector<int>>> cube;
map<int, vector<int>> m;
`);

test('Variadic generic type argument (pack expansion in type args)', `
class Tuple {};
class Args {};
Tuple<Args...> pack;
`);

console.log('\nAll tests completed!');
