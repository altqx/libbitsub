/**
 * WASM module management for libbitsub.
 */

let wasmModule: typeof import('../../pkg/libbitsub') | null = null;
let wasmInitPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module. Must be called before using any rendering functions.
 * Can be called early to pre-load the WASM module before it's needed.
 */
export async function initWasm(): Promise<void> {
    if (wasmModule) return;
    if (wasmInitPromise) return wasmInitPromise;
    
    wasmInitPromise = (async () => {
        const mod = await import('../../pkg/libbitsub');
        await mod.default();
        wasmModule = mod;
    })();
    
    return wasmInitPromise;
}

/** Check if WASM is initialized. */
export function isWasmInitialized(): boolean {
    return wasmModule !== null;
}

/** Get the WASM module, throwing if not initialized. */
export function getWasm(): typeof import('../../pkg/libbitsub') {
    if (!wasmModule) {
        throw new Error('WASM module not initialized. Call initWasm() first.');
    }
    return wasmModule;
}

/** Get the WASM file URL (always returns absolute URL). */
export function getWasmUrl(): string {
    // In a web environment with libbitsub served from public folder
    if (typeof window !== 'undefined') {
        return new URL('/libbitsub/libbitsub_bg.wasm', window.location.origin).href;
    }
    // Fallback for non-browser environments
    try {
        const baseUrl = new URL('.', import.meta.url).href;
        return new URL('../../pkg/libbitsub_bg.wasm', baseUrl).href;
    } catch {
        return '/libbitsub/libbitsub_bg.wasm';
    }
}

// Pre-initialize WASM module on first import (non-blocking)
if (typeof window !== 'undefined') {
    setTimeout(() => {
        initWasm().catch(err => console.warn('[libbitsub] WASM pre-init failed:', err));
    }, 100);
}
