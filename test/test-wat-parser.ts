import { parseWat, toWasm } from '../examples/wat-parser';

function testWat(name: string, wat: string) {
	console.log(`=== Test: ${name} ===`);
	try {
		const mod = parseWat(wat);
		console.log('parsed successfully.');
		const wmod = toWasm(mod);
		const bytes = wmod.toBytes();
		console.log(`Successfully parsed and encoded to ${bytes.length} bytes.`);
		console.log('toWAT output:');
		console.log(wmod.toWAT());
		console.log('PASSED\n');
	} catch (e) {
		console.error(`FAILED: ${(e as Error).message}\n`);
		if (e instanceof Error && e.stack)
			console.error(e.stack);
		process.exitCode = 1;
	}
}

testWat('Simple Add', `
(module
  (func $add (param $x i32) (param $y i32) (result i32)
    local.get $x
    local.get $y
    i32.add
  )
  (export "add" (func $add))
)
`);

testWat('Factorial with Loop & Branching', `
(module
  (func $factorial (export "factorial") (param $n i32) (result i32)
    (local $acc i32)
    i32.const 1
    local.set $acc
    block $done
      loop $top
        local.get $n
        i32.const 1
        i32.le_s
        br_if $done
        ;;local.get $acc
        ;;local.get $n
        (i32.mul (local.get $acc) (local.get $n))
        local.set $acc
        local.get $n
        i32.const 1
        i32.sub
        local.set $n
        br $top
      end
    end
    local.get $acc
  )
)
`);

testWat('Imports, Memory, Table, Globals, Data & Elem', `
(module
  (import "env" "print" (func $print (param i32)))
  (memory $mem 1 2)
  (table $tab 10 funcref)
  (global $g (mut i32) (i32.const 42))
  (func $main (export "main")
    i32.const 0
    global.get $g
    i32.store
    i32.const 0
    i32.load
    call $print
  )
  (data (i32.const 0) "Hello Wasm")
  (elem (i32.const 0) $main)
)
`);

testWat('Unnamed Import and Unnamed Data', `
(module
  (import "env" "log" (func (param i32)))
  (func $foo
    i32.const 42
    call $foo
  )
  (data "unnamed segment")
  (data $namedSeg "named segment")
  (func $test
    data.drop $namedSeg
  )
)
`);

// A one-armed if (no else) has no `else` field on its AST node at all -- toWasm's resolution
// pass must not unconditionally try to resolve one.
testWat('If with no else branch', `
(module
  (global $hit (mut i32) (i32.const 0))
  (func $f (export "f") (param $x i32)
    local.get $x
    if
      i32.const 1
      global.set $hit
    end
  )
)
`);
