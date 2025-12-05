/**
 * TypeScript wrapper for the libbitsub Rust rendering engine.
 * Provides a compatible API with the original libpgs-js implementation.
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
let wasmInitPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module. Must be called before using any rendering functions.
 */
export async function initWasm(): Promise<void> {
    if (wasmModule) return;
    if (wasmInitPromise) return wasmInitPromise;
    
    wasmInitPromise = (async () => {
        const mod = await import('../pkg/libbitsub');
        // Call the default init function to load and instantiate WASM
        await mod.default();
        wasmModule = mod;
    })();
    
    return wasmInitPromise;
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

// =============================================================================
// Low-Level Parsers (for programmatic use)
// =============================================================================

/**
 * Low-level PGS subtitle parser using WASM.
 * Use this for programmatic access to PGS data without video integration.
 */
export class PgsParser {
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
            const expectedLength = comp.width * comp.height * 4;
            
            // Validate buffer size
            if (rgba.length !== expectedLength || comp.width === 0 || comp.height === 0) {
                console.warn(`Invalid composition data: expected ${expectedLength} bytes, got ${rgba.length}, size=${comp.width}x${comp.height}`);
                continue;
            }

            // Copy to new Uint8ClampedArray to ensure proper buffer ownership
            const clampedData = new Uint8ClampedArray(rgba.length);
            clampedData.set(rgba);
            
            const imageData = new ImageData(
                clampedData,
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
 * Low-level VobSub subtitle parser using WASM.
 * Use this for programmatic access to VobSub data without video integration.
 */
export class VobSubParserLowLevel {
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
        const expectedLength = frame.width * frame.height * 4;
        
        // Validate buffer size
        if (rgba.length !== expectedLength || frame.width === 0 || frame.height === 0) {
            console.warn(`Invalid VobSub frame: expected ${expectedLength} bytes, got ${rgba.length}, size=${frame.width}x${frame.height}`);
            return {
                width: frame.screenWidth,
                height: frame.screenHeight,
                compositionData: [],
            };
        }
        
        // Copy to new Uint8ClampedArray to ensure proper buffer ownership
        const clampedData = new Uint8ClampedArray(rgba.length);
        clampedData.set(rgba);
        
        const imageData = new ImageData(
            clampedData,
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
 * Unified subtitle parser that handles both PGS and VobSub formats.
 */
export class UnifiedSubtitleParser {
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
            const expectedLength = width * height * 4;

            if (width > 0 && height > 0 && rgba.length === expectedLength) {
                // Copy to new Uint8ClampedArray to ensure proper buffer ownership
                const clampedData = new Uint8ClampedArray(rgba.length);
                clampedData.set(rgba);
                
                const imageData = new ImageData(
                    clampedData,
                    width,
                    height
                );

                compositionData.push({
                    pixelData: imageData,
                    x: result.getCompositionX(i),
                    y: result.getCompositionY(i),
                });
            } else if (width > 0 && height > 0) {
                console.warn(`Invalid unified result: expected ${expectedLength} bytes, got ${rgba.length}, size=${width}x${height}`);
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

// =============================================================================
// High-Level Video-Integrated Renderers (compatible with old libpgs-js API)
// =============================================================================

/**
 * Options for video subtitle renderers.
 */
export interface VideoSubtitleOptions {
    /** The video element to sync with */
    video: HTMLVideoElement;
    /** URL to the subtitle file */
    subUrl: string;
    /** Worker URL (kept for API compatibility, not used in WASM version) */
    workerUrl?: string;
}

/**
 * Options for VobSub video subtitle renderer.
 */
export interface VideoVobSubOptions extends VideoSubtitleOptions {
    /** URL to the .idx file (optional, defaults to subUrl with .idx extension) */
    idxUrl?: string;
}

/**
 * Base class for video-integrated subtitle renderers.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */
abstract class BaseVideoSubtitleRenderer {
    protected video: HTMLVideoElement;
    protected subUrl: string;
    protected canvas: HTMLCanvasElement | null = null;
    protected ctx: CanvasRenderingContext2D | null = null;
    protected animationFrameId: number | null = null;
    protected isLoaded: boolean = false;
    protected lastRenderedTime: number = -1;
    protected disposed: boolean = false;
    protected resizeObserver: ResizeObserver | null = null;

    constructor(options: VideoSubtitleOptions) {
        this.video = options.video;
        this.subUrl = options.subUrl;
        this.init();
    }

    /**
     * Initialize the renderer - set up canvas and start loading.
     */
    protected async init(): Promise<void> {
        await initWasm();
        this.createCanvas();
        await this.loadSubtitles();
        this.startRenderLoop();
    }

    /**
     * Create the canvas overlay positioned over the video.
     */
    protected createCanvas(): void {
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.zIndex = '10';  // Ensure canvas is above video
        
        // Insert canvas after video - ensure parent has relative positioning
        const parent = this.video.parentElement;
        if (parent) {
            const computedStyle = window.getComputedStyle(parent);
            if (computedStyle.position === 'static') {
                parent.style.position = 'relative';
            }
            parent.appendChild(this.canvas);
        }
        
        this.ctx = this.canvas.getContext('2d');
        this.updateCanvasSize();
        
        // Handle resize
        this.resizeObserver = new ResizeObserver(() => this.updateCanvasSize());
        this.resizeObserver.observe(this.video);
        
        // Update size when video metadata loads (in case dimensions weren't available yet)
        this.video.addEventListener('loadedmetadata', () => this.updateCanvasSize());
        
        // Re-render on seek
        this.video.addEventListener('seeked', () => {
            this.lastRenderedTime = -1;
        });
    }

    /**
     * Update canvas size to match video display size.
     */
    protected updateCanvasSize(): void {
        if (!this.canvas) return;
        
        const rect = this.video.getBoundingClientRect();
        // Use video dimensions if available, fallback to intrinsic size
        const width = rect.width > 0 ? rect.width : (this.video.videoWidth || 1920);
        const height = rect.height > 0 ? rect.height : (this.video.videoHeight || 1080);
        
        this.canvas.width = width * window.devicePixelRatio;
        this.canvas.height = height * window.devicePixelRatio;
        
        // Clear and re-render on resize
        this.lastRenderedTime = -1;
    }

    /**
     * Load subtitles from URL. Must be implemented by subclasses.
     */
    protected abstract loadSubtitles(): Promise<void>;

    /**
     * Render subtitle at the given time. Must be implemented by subclasses.
     */
    protected abstract renderAtTime(time: number): SubtitleData | undefined;

    /**
     * Start the render loop synced to video playback.
     */
    protected startRenderLoop(): void {
        const render = () => {
            if (this.disposed) return;
            
            if (this.isLoaded) {
                const currentTime = this.video.currentTime;
                
                // Re-render if time has changed significantly OR if we haven't rendered yet
                // Also render when paused so subtitles are visible
                if (Math.abs(currentTime - this.lastRenderedTime) > 0.01 || this.lastRenderedTime < 0) {
                    this.renderFrame(currentTime);
                    this.lastRenderedTime = currentTime;
                }
            }
            
            this.animationFrameId = requestAnimationFrame(render);
        };
        
        this.animationFrameId = requestAnimationFrame(render);
    }

    /**
     * Render a subtitle frame to the canvas.
     */
    protected renderFrame(time: number): void {
        if (!this.ctx || !this.canvas) return;
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        const data = this.renderAtTime(time);
        if (!data || data.compositionData.length === 0) return;
        
        // Calculate scale to fit subtitle to canvas
        const scaleX = this.canvas.width / data.width;
        const scaleY = this.canvas.height / data.height;
        
        // Log first render for debugging
        if (this.lastRenderedTime < 0) {
            console.log(`[libbitsub] First render at ${time}s:`, {
                canvasSize: { w: this.canvas.width, h: this.canvas.height },
                subtitleSize: { w: data.width, h: data.height },
                compositionCount: data.compositionData.length,
                scale: { x: scaleX, y: scaleY }
            });
        }
        
        // Render each composition synchronously using temp canvas
        for (const comp of data.compositionData) {
            const destX = comp.x * scaleX;
            const destY = comp.y * scaleY;
            const destWidth = comp.pixelData.width * scaleX;
            const destHeight = comp.pixelData.height * scaleY;
            
            // Create temporary canvas to hold the ImageData
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = comp.pixelData.width;
            tempCanvas.height = comp.pixelData.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) continue;
            
            tempCtx.putImageData(comp.pixelData, 0, 0);
            
            // Draw scaled to main canvas
            this.ctx.drawImage(tempCanvas, destX, destY, destWidth, destHeight);
        }
    }

    /**
     * Dispose of all resources.
     */
    dispose(): void {
        this.disposed = true;
        
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        
        if (this.canvas && this.canvas.parentElement) {
            this.canvas.parentElement.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
    }
}

/**
 * High-level PGS subtitle renderer that integrates with video playback.
 * Compatible with the old libpgs-js API.
 * 
 * @example
 * ```typescript
 * const renderer = new PgsRenderer({
 *     video: videoElement,
 *     subUrl: '/subtitles/movie.sup',
 *     workerUrl: '/libbitsub.worker.js' // Not used in WASM version
 * });
 * 
 * // Later, when done:
 * renderer.dispose();
 * ```
 */
export class PgsRenderer extends BaseVideoSubtitleRenderer {
    private pgsParser: PgsParser | null = null;

    constructor(options: VideoSubtitleOptions) {
        super(options);
    }

    protected async loadSubtitles(): Promise<void> {
        try {
            this.pgsParser = new PgsParser();
            const response = await fetch(this.subUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch subtitle: ${response.status}`);
            }
            const data = new Uint8Array(await response.arrayBuffer());
            const count = this.pgsParser.load(data);
            this.isLoaded = true;
            console.log(`[libbitsub] PGS loaded: ${count} display sets from ${data.byteLength} bytes`);
        } catch (error) {
            console.error('Failed to load PGS subtitles:', error);
        }
    }

    protected renderAtTime(time: number): SubtitleData | undefined {
        return this.pgsParser?.renderAtTimestamp(time);
    }

    dispose(): void {
        super.dispose();
        this.pgsParser?.dispose();
        this.pgsParser = null;
    }
}

/**
 * High-level VobSub subtitle renderer that integrates with video playback.
 * Compatible with the old libpgs-js API.
 * 
 * @example
 * ```typescript
 * const renderer = new VobSubRenderer({
 *     video: videoElement,
 *     subUrl: '/subtitles/movie.sub',
 *     idxUrl: '/subtitles/movie.idx', // Optional
 *     workerUrl: '/libbitsub.worker.js' // Not used in WASM version
 * });
 * 
 * // Later, when done:
 * renderer.dispose();
 * ```
 */
export class VobSubRenderer extends BaseVideoSubtitleRenderer {
    private vobsubParser: VobSubParserLowLevel | null = null;
    private idxUrl: string;

    constructor(options: VideoVobSubOptions) {
        super(options);
        this.idxUrl = options.idxUrl || options.subUrl.replace(/\.sub$/i, '.idx');
    }

    protected async loadSubtitles(): Promise<void> {
        try {
            this.vobsubParser = new VobSubParserLowLevel();
            const [subResponse, idxResponse] = await Promise.all([
                fetch(this.subUrl),
                fetch(this.idxUrl),
            ]);

            if (!subResponse.ok) {
                throw new Error(`Failed to fetch .sub file: ${subResponse.status}`);
            }
            if (!idxResponse.ok) {
                throw new Error(`Failed to fetch .idx file: ${idxResponse.status}`);
            }

            const subData = new Uint8Array(await subResponse.arrayBuffer());
            const idxData = await idxResponse.text();

            this.vobsubParser.loadFromData(idxData, subData);
            this.isLoaded = true;
        } catch (error) {
            console.error('Failed to load VobSub subtitles:', error);
        }
    }

    protected renderAtTime(time: number): SubtitleData | undefined {
        return this.vobsubParser?.renderAtTimestamp(time);
    }

    dispose(): void {
        super.dispose();
        this.vobsubParser?.dispose();
        this.vobsubParser = null;
    }
}

// =============================================================================
// Legacy Aliases (for backward compatibility)
// =============================================================================

/** @deprecated Use PgsRenderer instead */
export const PGSRenderer = PgsRenderer;

/** @deprecated Use VobSubRenderer instead */
export const VobsubRenderer = VobSubRenderer;

/** @deprecated Use UnifiedSubtitleParser instead */
export const UnifiedSubtitleRenderer = UnifiedSubtitleParser;
