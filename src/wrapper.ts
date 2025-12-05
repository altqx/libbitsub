/**
 * TypeScript wrapper for the libbitsub Rust rendering engine.
 * Provides a compatible API with the original libbitsub-js implementation.
 */

import type {
    SubtitleRenderer as WasmSubtitleRenderer,
    PgsParser as WasmPgsParser,
    VobSubParser as WasmVobSubParser,
    RenderResult,
    SubtitleFrame,
    VobSubFrame,
    SubtitleFormat,
} from '../pkg/libbitsub';

// Re-export types
export type { RenderResult, SubtitleFrame, VobSubFrame };

/** WASM module instance */
let wasmModule: typeof import('../pkg/libbitsub') | null = null;

/**
 * Initialize the WASM module. Must be called before using any rendering functions.
 */
export async function initWasm(): Promise<void> {
    if (wasmModule) return;
    wasmModule = await import('../pkg/libbitsub');
}

/**
 * Check if WASM is initialized.
 */
export function isWasmInitialized(): boolean {
    return wasmModule !== null;
}

/**
 * Get the WASM module, throwing if not initialized.
 */
function getWasm(): typeof import('../pkg/libbitsub') {
    if (!wasmModule) {
        throw new Error('WASM module not initialized. Call initWasm() first.');
    }
    return wasmModule;
}

/**
 * Subtitle data output format compatible with the original JS implementation.
 */
export interface SubtitleData {
    /** Total width of the presentation (screen). */
    width: number;
    /** Total height of the presentation (screen). */
    height: number;
    /** Pre-compiled composition elements. */
    compositionData: SubtitleCompositionData[];
}

/**
 * A single composition element.
 */
export interface SubtitleCompositionData {
    /** The compiled pixel data of the subtitle. */
    pixelData: ImageData;
    /** X position on screen. */
    x: number;
    /** Y position on screen. */
    y: number;
}

/**
 * High-performance PGS subtitle renderer using WASM.
 */
export class PgsRenderer {
    private parser: WasmPgsParser | null = null;
    private timestamps: Float64Array = new Float64Array(0);

    constructor() {
        const wasm = getWasm();
        this.parser = new wasm.PgsParser();
    }

    /**
     * Load PGS subtitle data from a Uint8Array.
     */
    load(data: Uint8Array): number {
        if (!this.parser) throw new Error('Parser not initialized');
        const count = this.parser.parse(data);
        this.timestamps = this.parser.getTimestamps();
        return count;
    }

    /**
     * Get all timestamps in milliseconds.
     */
    getTimestamps(): Float64Array {
        return this.timestamps;
    }

    /**
     * Get the number of display sets.
     */
    get count(): number {
        return this.parser?.count ?? 0;
    }

    /**
     * Find the display set index for a given timestamp in seconds.
     */
    findIndexAtTimestamp(timeSeconds: number): number {
        if (!this.parser) return -1;
        return this.parser.findIndexAtTimestamp(timeSeconds * 1000);
    }

    /**
     * Render subtitle at the given index.
     */
    renderAtIndex(index: number): SubtitleData | undefined {
        if (!this.parser) return undefined;
        
        const frame = this.parser.renderAtIndex(index);
        if (!frame) return undefined;

        return this.convertFrame(frame);
    }

    /**
     * Render subtitle at the given timestamp in seconds.
     */
    renderAtTimestamp(timeSeconds: number): SubtitleData | undefined {
        const index = this.findIndexAtTimestamp(timeSeconds);
        if (index < 0) return undefined;
        return this.renderAtIndex(index);
    }

    /**
     * Convert WASM frame to SubtitleData.
     */
    private convertFrame(frame: SubtitleFrame): SubtitleData {
        const compositionData: SubtitleCompositionData[] = [];

        for (let i = 0; i < frame.compositionCount; i++) {
            const comp = frame.getComposition(i);
            if (!comp) continue;

            const rgba = comp.getRgba();
            const imageData = new ImageData(
                new Uint8ClampedArray(rgba),
                comp.width,
                comp.height
            );

            compositionData.push({
                pixelData: imageData,
                x: comp.x,
                y: comp.y,
            });
        }

        return {
            width: frame.width,
            height: frame.height,
            compositionData,
        };
    }

    /**
     * Clear internal caches.
     */
    clearCache(): void {
        this.parser?.clearCache();
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.parser?.free();
        this.parser = null;
        this.timestamps = new Float64Array(0);
    }
}

/**
 * High-performance VobSub subtitle renderer using WASM.
 */
export class VobSubRenderer {
    private parser: WasmVobSubParser | null = null;
    private timestamps: Float64Array = new Float64Array(0);

    constructor() {
        const wasm = getWasm();
        this.parser = new wasm.VobSubParser();
    }

    /**
     * Load VobSub from IDX and SUB data.
     */
    loadFromData(idxContent: string, subData: Uint8Array): void {
        if (!this.parser) throw new Error('Parser not initialized');
        this.parser.loadFromData(idxContent, subData);
        this.timestamps = this.parser.getTimestamps();
    }

    /**
     * Load VobSub from SUB file only.
     */
    loadFromSubOnly(subData: Uint8Array): void {
        if (!this.parser) throw new Error('Parser not initialized');
        this.parser.loadFromSubOnly(subData);
        this.timestamps = this.parser.getTimestamps();
    }

    /**
     * Get all timestamps in milliseconds.
     */
    getTimestamps(): Float64Array {
        return this.timestamps;
    }

    /**
     * Get the number of subtitle entries.
     */
    get count(): number {
        return this.parser?.count ?? 0;
    }

    /**
     * Find the subtitle index for a given timestamp in seconds.
     */
    findIndexAtTimestamp(timeSeconds: number): number {
        if (!this.parser) return -1;
        return this.parser.findIndexAtTimestamp(timeSeconds * 1000);
    }

    /**
     * Render subtitle at the given index.
     */
    renderAtIndex(index: number): SubtitleData | undefined {
        if (!this.parser) return undefined;
        
        const frame = this.parser.renderAtIndex(index);
        if (!frame) return undefined;

        return this.convertFrame(frame);
    }

    /**
     * Render subtitle at the given timestamp in seconds.
     */
    renderAtTimestamp(timeSeconds: number): SubtitleData | undefined {
        const index = this.findIndexAtTimestamp(timeSeconds);
        if (index < 0) return undefined;
        return this.renderAtIndex(index);
    }

    /**
     * Convert WASM frame to SubtitleData.
     */
    private convertFrame(frame: VobSubFrame): SubtitleData {
        const rgba = frame.getRgba();
        const imageData = new ImageData(
            new Uint8ClampedArray(rgba),
            frame.width,
            frame.height
        );

        return {
            width: frame.screenWidth,
            height: frame.screenHeight,
            compositionData: [{
                pixelData: imageData,
                x: frame.x,
                y: frame.y,
            }],
        };
    }

    /**
     * Clear internal caches.
     */
    clearCache(): void {
        this.parser?.clearCache();
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.parser?.free();
        this.parser = null;
        this.timestamps = new Float64Array(0);
    }
}

/**
 * Unified subtitle renderer that handles both PGS and VobSub formats.
 */
export class UnifiedSubtitleRenderer {
    private renderer: WasmSubtitleRenderer | null = null;
    private timestamps: Float64Array = new Float64Array(0);

    constructor() {
        const wasm = getWasm();
        this.renderer = new wasm.SubtitleRenderer();
    }

    /**
     * Load PGS subtitle data.
     */
    loadPgs(data: Uint8Array): number {
        if (!this.renderer) throw new Error('Renderer not initialized');
        const count = this.renderer.loadPgs(data);
        this.timestamps = this.renderer.getTimestamps();
        return count;
    }

    /**
     * Load VobSub from IDX and SUB data.
     */
    loadVobSub(idxContent: string, subData: Uint8Array): void {
        if (!this.renderer) throw new Error('Renderer not initialized');
        this.renderer.loadVobSub(idxContent, subData);
        this.timestamps = this.renderer.getTimestamps();
    }

    /**
     * Load VobSub from SUB file only.
     */
    loadVobSubOnly(subData: Uint8Array): void {
        if (!this.renderer) throw new Error('Renderer not initialized');
        this.renderer.loadVobSubOnly(subData);
        this.timestamps = this.renderer.getTimestamps();
    }

    /**
     * Get the current subtitle format.
     */
    get format(): 'pgs' | 'vobsub' | null {
        const fmt = this.renderer?.format;
        if (fmt === 0) return 'pgs';
        if (fmt === 1) return 'vobsub';
        return null;
    }

    /**
     * Get all timestamps in milliseconds.
     */
    getTimestamps(): Float64Array {
        return this.timestamps;
    }

    /**
     * Get the number of subtitle entries.
     */
    get count(): number {
        return this.renderer?.count ?? 0;
    }

    /**
     * Find the subtitle index for a given timestamp in seconds.
     */
    findIndexAtTimestamp(timeSeconds: number): number {
        if (!this.renderer) return -1;
        return this.renderer.findIndexAtTimestamp(timeSeconds * 1000);
    }

    /**
     * Render subtitle at the given index.
     */
    renderAtIndex(index: number): SubtitleData | undefined {
        if (!this.renderer) return undefined;
        
        const result = this.renderer.renderAtIndex(index);
        if (!result) return undefined;

        return this.convertResult(result);
    }

    /**
     * Render subtitle at the given timestamp in seconds.
     */
    renderAtTimestamp(timeSeconds: number): SubtitleData | undefined {
        if (!this.renderer) return undefined;
        
        const result = this.renderer.renderAtTimestamp(timeSeconds);
        if (!result) return undefined;

        return this.convertResult(result);
    }

    /**
     * Convert WASM result to SubtitleData.
     */
    private convertResult(result: RenderResult): SubtitleData {
        const compositionData: SubtitleCompositionData[] = [];

        for (let i = 0; i < result.compositionCount; i++) {
            const rgba = result.getCompositionRgba(i);
            const width = result.getCompositionWidth(i);
            const height = result.getCompositionHeight(i);

            if (width > 0 && height > 0) {
                const imageData = new ImageData(
                    new Uint8ClampedArray(rgba),
                    width,
                    height
                );

                compositionData.push({
                    pixelData: imageData,
                    x: result.getCompositionX(i),
                    y: result.getCompositionY(i),
                });
            }
        }

        return {
            width: result.screenWidth,
            height: result.screenHeight,
            compositionData,
        };
    }

    /**
     * Clear internal caches.
     */
    clearCache(): void {
        this.renderer?.clearCache();
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.renderer?.dispose();
        this.renderer?.free();
        this.renderer = null;
        this.timestamps = new Float64Array(0);
    }
}
