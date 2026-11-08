#!/usr/bin/env bun
/**
 * Builds pkg-compat/: a WebAssembly MVP build for engines without newer WASM
 * features (Chromium 57-95, e.g. Samsung Tizen 5.0-7.0 and webOS 5-23 TVs).
 *
 * 1. Compile with `target-cpu=mvp`. The precompiled Rust std still contains
 *    sign-ext, bulk-memory and non-trapping float-to-int instructions, and marks
 *    reference types and multi-value as used in the `target_features` section.
 *    wasm-bindgen picks its glue ABI from that section, so the linker writes an
 *    empty feature list instead.
 * 2. Lower the std instructions to MVP with Binaryen and optimize like pkg/.
 * 3. Validate the result as pure MVP so a regression fails the build.
 */
import { $ } from 'bun'

const OUT_DIR = 'pkg-compat'
const WASM = `${OUT_DIR}/libbitsub_bg.wasm`
const WASM_OPT = 'node_modules/.bin/wasm-opt'

await $`wasm-pack build --release --no-opt --target web --out-dir ${OUT_DIR}`.env({
  ...process.env,
  CARGO_TARGET_DIR: 'target/compat',
  RUSTFLAGS: '-C target-cpu=mvp -C link-arg=--features= -C link-arg=--no-check-features'
})

await $`${WASM_OPT} ${WASM} --enable-sign-ext --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --signext-lowering --llvm-memory-copy-fill-lowering --llvm-nontrapping-fptoint-lowering -O4 -o ${WASM}`

const validation = await $`${WASM_OPT} ${WASM} --mvp-features`.nothrow().quiet()
if (validation.exitCode !== 0) {
  console.error(validation.stderr.toString())
  throw new Error(`${WASM} is not a valid WebAssembly MVP module`)
}
console.log(`${WASM} validated as WebAssembly MVP`)
