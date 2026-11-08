/**
 * WASM module management for libbitsub.
 *
 * Two builds ship side by side:
 * - `pkg/` targets current engines (reference types + multi-value).
 * - `pkg-compat/` is a WebAssembly MVP build for older engines such as Chromium 57-95
 *   (e.g. Samsung Tizen 5.0-7.0 TVs). Its glue code is not interchangeable with `pkg/`.
 */

type WasmModule = typeof import('../../pkg/libbitsub')

/** Which WASM build is used by the current engine. */
export type WasmVariant = 'modern' | 'compat'

let wasmModule: WasmModule | null = null
let wasmInitPromise: Promise<void> | null = null
let wasmVariant: WasmVariant | null = null

// (module (func (result i32 i32) i32.const 0 i32.const 0))
const MULTI_VALUE_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 0, 2, 127, 127, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 65, 0, 11
])

// (module (func (drop (ref.null extern))))
const REFERENCE_TYPES_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 7, 1, 5, 0, 208, 111, 26, 11
])

function detectWasmVariant(): WasmVariant {
  try {
    if (WebAssembly.validate(MULTI_VALUE_PROBE) && WebAssembly.validate(REFERENCE_TYPES_PROBE)) {
      return 'modern'
    }
  } catch {
    /* fall through to compat */
  }
  return 'compat'
}

/** Get the WASM build selected for the current engine. */
export function getWasmVariant(): WasmVariant {
  wasmVariant ??= detectWasmVariant()
  return wasmVariant
}

/**
 * Initialize the WASM module. Must be called before using any rendering functions.
 * Can be called early to pre-load the WASM module before it's needed.
 */
export async function initWasm(): Promise<void> {
  if (wasmModule) return
  if (wasmInitPromise) return wasmInitPromise

  wasmInitPromise = (async () => {
    // Both builds expose the same public classes; only the internal WASM ABI differs.
    const mod =
      getWasmVariant() === 'modern'
        ? await import('../../pkg/libbitsub')
        : ((await import('../../pkg-compat/libbitsub')) as unknown as WasmModule)
    await mod.default()
    wasmModule = mod
  })()

  return wasmInitPromise
}

/** Check if WASM is initialized. */
export function isWasmInitialized(): boolean {
  return wasmModule !== null
}

/** Get the WASM module, throwing if not initialized. */
export function getWasm(): WasmModule {
  if (!wasmModule) {
    throw new Error('WASM module not initialized. Call initWasm() first.')
  }
  return wasmModule
}

function getPublicFallbackUrl(fileName: string): string {
  const path = getWasmVariant() === 'modern' ? `/libbitsub/${fileName}` : `/libbitsub/compat/${fileName}`
  if (typeof window !== 'undefined') {
    return new URL(path, window.location.origin).href
  }

  return path
}

// The `new URL('<literal>', import.meta.url)` calls stay literal so bundlers emit both builds as assets.

/** Get the WASM file URL (always returns absolute URL). */
export function getWasmUrl(): string {
  try {
    return getWasmVariant() === 'modern'
      ? new URL('../../pkg/libbitsub_bg.wasm', import.meta.url).href
      : new URL('../../pkg-compat/libbitsub_bg.wasm', import.meta.url).href
  } catch {
    return getPublicFallbackUrl('libbitsub_bg.wasm')
  }
}

/** Get the WASM glue script URL (always returns absolute URL).*/
export function getWasmGlueUrl(): string {
  try {
    return getWasmVariant() === 'modern'
      ? new URL('../../pkg/libbitsub.js', import.meta.url).href
      : new URL('../../pkg-compat/libbitsub.js', import.meta.url).href
  } catch {
    return getPublicFallbackUrl('libbitsub.js')
  }
}

// Pre-initialize WASM module on first import (non-blocking)
if (typeof window !== 'undefined') {
  setTimeout(() => {
    initWasm().catch((err) => console.warn('[libbitsub] WASM pre-init failed:', err))
  }, 100)
}
