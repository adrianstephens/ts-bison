import {cppParser} from '../examples/cpp-parser';

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

// ===================================================================
//  C++14 feature coverage (compact: pass/fail only, AST not dumped)
// ===================================================================

let pass = 0, fail = 0;
function check(name: string, code: string, knownTypes?: string[]) {
	try {
		cppParser.parse(code, knownTypes);
		pass++;
	} catch (e: any) {
		fail++;
		console.error(`FAIL: ${name}: ${(e.message as string).split('. Expected')[0]}`);
	}
}

// --- literals ---
check('hex literal', `int x = 0xFF;`);
check('binary literal', `int x = 0b1010;`);
check('digit separators', `int x = 1'000'000;`);
check('ull suffix', `unsigned long long x = 5ULL;`);
check('exponent float', `double d = 1e5; double e = 2.5e-3f;`);
check('leading dot float', `double d = .5;`);
check('prefixed strings', `int main() { f(u8"a"); f(u"b"); f(U"c"); f(L"d"); }`);
check('raw string', `const char* s = R"(no \\escapes "here")";`);
check('raw string custom delim', `const char* s = R"xy(a )" b)xy";`);
check('prefixed char', `int main() { f(u'a'); f(L'b'); }`);

// --- auto / decltype ---
check('auto variable', `int main() { auto x = 5; }`);
check('auto ref/ptr', `int main() { int y = 1; auto& r = y; auto* p = &y; const auto& cr = y; }`);
check('auto return deduction', `auto f() { return 42; }`);
check('trailing return type', `auto f(int x) -> int { return x; }`);
check('generic lambda (C++14)', `int main() { auto g = [](auto x, auto y) { return x + y; }; }`);
check('decltype', `int main() { int a = 1; decltype(a) b = 2; }`);
check('decltype(auto)', `decltype(auto) f() { return 1; }`);
check('wchar/char16/char32', `wchar_t a; char16_t b; char32_t c;`);

// --- references / parameters ---
check('rvalue reference param', `void f(int&& x) {}`);
check('rvalue ref declarator', `int main() { int a = 1; int&& r = g(); }`);
check('unnamed params', `void f(int*, const char&, int&&);`);
check('forwarding reference pack', `template<typename... Args> void fwd(Args&&... args) { target(args...); }`);

// --- specifiers ---
check('constexpr var/function', `constexpr int sq(int x) { return x * x; } constexpr int n = sq(4);`);
check('static constexpr member', `class C { static constexpr int x = 5; };`);
check('inline function', `inline int f() { return 1; }`);
check('thread_local', `thread_local int counter = 0;`);
check('extern C single', `extern "C" int f(int);`);
check('extern C block', `extern "C" { int f(int); int g(void); }`);
check('static_assert', `static_assert(sizeof(int) == 4, "int must be 4 bytes");`);

// --- casts / typeid / alignof ---
check('static_cast', `int main() { double d = 3.5; int x = static_cast<int>(d); }`);
check('all four casts', `int main() { f(static_cast<int>(a), dynamic_cast<int*>(b), reinterpret_cast<long>(c), const_cast<char*>(d)); }`);
check('cast with generic target', `class vector {}; int main() { auto v = static_cast<vector<int>>(x); }`);
check('cast target with rvalue ref', `int main() { int y = 5; f(static_cast<int&&>(y)); }`);
check('typeid', `int main() { f(typeid(int)); g(typeid(x)); }`);
check('alignof', `int n = alignof(double);`);
check('functional cast', `class T {}; int main() { auto t = T(); auto u = T(1, 2); }`);

// --- attributes (lexically skipped) ---
check('attributes', `[[nodiscard]] int f() { return 1; }
int g([[maybe_unused]] int x) { return 0; }`);

// --- enums ---
check('enum class', `enum class Color { RED, GREEN, BLUE };`);
check('enum class with base', `enum class Flags : unsigned { A, B };`);
check('enum class base + trailing comma', `enum class Kind : int { CIRCLE, SQUARE, };`);
check('enum with base', `enum E : int { X, Y };`);
check('opaque enum decl', `enum class Color : int;`);
check('enum name is a type after def', `enum Color { RED }; Color c;`);
check('scoped enum access', `enum class Color { RED }; int main() { Color c = Color::RED; }`);
check('qualified case labels', `enum class Color { RED, GREEN };
int f(Color c) { switch (c) { case Color::RED: return 1; default: return 0; } }`);

// --- struct/class C++ semantics ---
check('struct name usable bare', `struct Point { int x; int y; }; Point p;`);
check('struct self-reference', `struct Node { int v; Node* next; };`);
check('struct with methods and bases', `struct Base { virtual void f() {} };
struct Derived : public Base { void f() override {} };`);
check('class forward declaration', `class Foo; class Foo { int x; };`);
check('class final', `class Base {}; class Sealed final : public Base {};`);
check('union named', `union U { int i; float f; }; U u;`);
check('nested class + qualified type', `class Outer { public: class Inner { public: int x; }; };
Outer::Inner obj;`);

// --- members ---
check('member arrays', `class C { int arr[10]; char buf[256]; };`);
check('pointer/ref members', `class C { int* p; int& r; };`);
check('NSDMI', `class C { int x = 5; int* p = nullptr; };`);
check('method declaration only', `class C { int get() const; void set(int v); };`);
check('override/final', `class B { virtual int f() const { return 0; } };
class D : public B { int f() const override { return 1; } };
class E : public D { int f() const final { return 2; } };`);
check('pure virtual', `class Shape { virtual int area() const = 0; virtual ~Shape() {} };`);
check('= default / = delete', `class C {
	C() = default;
	C(const C&) = delete;
	C& operator=(const C&) = delete;
	~C() = default;
};`);
check('explicit ctor', `class C { explicit C(int x) {} };`);
check('delegating ctor', `class C { C() : C(0) {} C(int x) {} };`);
check('mutable member', `class C { mutable int cache; };`);
check('friend class', `class B; class A { friend class B; };`);
check('noexcept method', `class C { int f() const noexcept { return 1; } void g() noexcept {} };`);
check('static method + qualified call', `class Counter { static int next() { return 1; } };
int main() { return Counter::next(); }`);
check('member using alias', `class C { using size_type = unsigned int; size_type n; };`);
check('member template', `class C { template<class U> void set(U x) {} };`);
check('virtual dtor =default', `class C { virtual ~C() = default; };`);
check('member returning generic', `template<class T> class vector {};
class C { vector<int> items; vector<int> get() const { return items; } void add(const vector<int>& v) {} };`);

// --- operator overloading ---
check('member operators', `class V {
	int x;
	V operator+(const V& o) const { return o; }
	V& operator+=(const V& o) { return *this; }
	bool operator==(const V& o) const { return true; }
	int operator[](int i) const { return x; }
	int operator()(int a, int b) { return a + b; }
};`);
check('conversion operator', `class C { operator bool() const { return true; } operator char*() { return 0; } };`);
check('free operator', `class V {}; V operator+(const V& a, const V& b) { return a; }`);
check('free operator declaration', `class V {}; bool operator==(const V& a, const V& b);`);

// --- out-of-class definitions ---
check('out-of-class methods', `class Foo { int getX() const; void setX(int v); int x; };
int Foo::getX() const { return x; }
void Foo::setX(int v) { x = v; }`);
check('out-of-class ctor/dtor', `class Foo { Foo(int x); ~Foo(); int x; };
Foo::Foo(int x) : x(x) {}
Foo::~Foo() {}`);
check('out-of-class operator', `class V { V operator+(const V& o) const; };
V V::operator+(const V& o) const { return o; }`);
check('out-of-class static member init', `class C { static int count; };
int C::count = 0;`);

// --- namespaces / qualified names ---
check('namespace member access', `namespace math { int sq(int x) { return x * x; } }
int main() { return math::sq(3); }`);
check('nested qualified call', `namespace a { namespace b { int f() { return 1; } } }
int main() { return a::b::f(); }`);
check('inline namespace', `inline namespace v1 { int f() { return 1; } }`);
check('typename dependent type', `template<typename T> typename T::value_type first(T& c) { return c[0]; }`);
check('std:: with seeded types', `int main() { std::vector<int> v; std::string s; }`, ['std', 'string']);
check('std::cout unseeded', `int main() { std::cout << "hi" << std::endl; }`);

// --- using ---
check('using alias', `using Integer = int; Integer x = 5;`);
check('using alias fn-ptr', `using Callback = void (*)(int);`);
check('alias template', `template<class T> class vector {}; template<class T> using Vec = vector<T>;`);
check('using declaration', `namespace ns { int x; } using ns::x;`);

// --- statements ---
check('range-based for', `int main() { int arr[] = {1, 2, 3}; int total = 0; for (int v : arr) total += v; }`);
check('range for auto&', `void f(int (&arr)[3]) { for (auto& v : arr) v++; }`);
check('range for const auto&', `class vector {}; int main() { vector<int> v; for (const auto& x : v) use(x); }`);
check('for with empty clauses', `int main() {
	for (;;) break;
	for (; x < 10;) x++;
	for (;; x++) break;
	for (int i = 0;;) break;
	for (int i = 0;; i++) break;
	for (int i = 0; i < 10;) i++;
}`);
check('braced init decl', `class vector {}; int main() { vector<int> v{1, 2, 3}; int x{5}; }`);
check('return braced', `class Pair {}; Pair mk() { return {1, 2}; }`);
check('empty function body still works', `int f() {} int g() { return 1; }`);
check('try/catch by const ref', `int main() {
	try { throw 5; } catch (const int& e) { return 1; } catch (...) { return 2; }
}`);

// --- templates ---
check('non-type template param', `template<int N> class Arr { int data[N]; };`);
check('non-type template arg', `template<class T, int N> class array {}; array<int, 5> a;`);
check('non-type arg expr (parenthesized)', `template<int N> class A {}; A<(2 + 3)> a;`);
check('default template args', `template<class T = int> class Box { T v; };`);
check('variable template (C++14)', `template<typename T> constexpr T pi = T(3.141592653589793);`);
check('explicit specialization', `template<class T> class Box { T v; };
template<> class Box<int> { int v; };`);
check('partial specialization', `template<class T> class Box { T v; };
template<class T> class Box<T*> { T* p; };`);
check('generic base class', `template<class T> class Base {};
class D : public Base<int> {};`);

// --- lambdas ---
check('init capture (C++14)', `int main() { int y = 1; auto f = [x = y + 1]() { return x; }; }`);
check('IIFE lambda', `int x = []() { return 42; }();`);
check('lambda kitchen sink', `int main() {
	int a = 1, b = 2;
	auto f = [&, b](auto x) mutable -> int { a += b; return a + x; };
	return f(3);
}`);

// --- misc C gaps fixed en route ---
check('zero-arg call', `int main() { return g(); }`);
check('new T() / new T{}', `class Foo {}; int main() { Foo* p = new Foo(); Foo* q = new Foo{1}; delete p; }`);
check('cv-qualified pointers', `const char* const* argv2 = 0;`);
check('cout-style chaining', `int main() { std::cout << "x = " << x << std::endl; return 0; }`);

// --- one realistic program pulling most of it together ---
check('realistic combined program', `
#include <vector>
namespace geo {
enum class Kind : int { CIRCLE, SQUARE, };
class Shape {
public:
	Shape() : id_(next_id_++) {}
	virtual ~Shape() = default;
	virtual double area() const noexcept = 0;
	virtual Kind kind() const = 0;
	int id() const { return id_; }
	static int count() { return next_id_; }
private:
	int id_;
	static int next_id_;
};
int Shape::next_id_ = 0;
class Circle final : public Shape {
public:
	explicit Circle(double r) : r_(r) {}
	double area() const noexcept override { return 3.14159 * r_ * r_; }
	Kind kind() const override { return Kind::CIRCLE; }
	Circle& operator*=(double f) { r_ *= f; return *this; }
private:
	double r_ = 1.0;
};
template<typename T, int N>
class FixedStack {
public:
	FixedStack() = default;
	bool push(const T& v) {
		if (size_ >= N)
			return false;
		data_[size_++] = v;
		return true;
	}
	template<class U> void assign(U v) { data_[0] = v; }
	using value_type = T;
private:
	T data_[N];
	int size_ = 0;
};
template<typename... Args>
int count_args(Args&&... args) {
	return sizeof...(Args);
}
}
using namespace geo;
using geo::Circle;
int describe(const Shape& s) {
	try {
		switch (s.kind()) {
		case Kind::CIRCLE: return 1;
		default: throw 0;
		}
	} catch (const int& e) {
		return -1;
	} catch (...) {
		return -2;
	}
}
auto make_scaler(double f) {
	return [f](Circle& c) { c *= f; };
}
int main(int argc, char* argv[]) {
	FixedStack<double, 8> st;
	st.push(1.5);
	Circle c{2.0};
	auto scale = make_scaler(0.5);
	scale(c);
	double total = 0.0;
	double areas[] = { c.area(), 4.0 };
	for (auto& a : areas)
		total += a;
	for (;;) break;
	int n = count_args(1, 2u, 0x3F, 0b101, 1'000'000);
	static_assert(sizeof(int) == 4, "assumes 32-bit int");
	return static_cast<int>(total) + n;
}
`);

console.log(`\nC++14 coverage: ${pass} passed, ${fail} failed`);
console.log('\nAll tests completed!');
