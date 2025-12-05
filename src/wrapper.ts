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
} from '../pkg/libbitsub';

// Re-export types
export type { RenderResult, SubtitleFrame, VobSubFrame };

// =============================================================================
// Types and Interfaces
// =============================================================================

/** Subtitle data output format compatible with the original JS implementation. */
export interface SubtitleData {
    /** Total width of the presentation (screen). */
    width: number;
    /** Total height of the presentation (screen). */
    height: number;
    /** Pre-compiled composition elements. */
    compositionData: SubtitleCompositionData[];
}

/** A single composition element. */
export interface SubtitleCompositionData {
    /** The compiled pixel data of the subtitle. */
    pixelData: ImageData;
    /** X position on screen. */
    x: number;
    /** Y position on screen. */
    y: number;
}

/** Options for video subtitle renderers. */
export interface VideoSubtitleOptions {
    /** The video element to sync with */
    video: HTMLVideoElement;
    /** URL to the subtitle file */
    subUrl: string;
    /** Worker URL (kept for API compatibility, not used in WASM version) */
    workerUrl?: string;
}

/** Options for VobSub video subtitle renderer. */
export interface VideoVobSubOptions extends VideoSubtitleOptions {
    /** URL to the .idx file (optional, defaults to subUrl with .idx extension) */
    idxUrl?: string;
}

// =============================================================================
// WASM Module Management
// =============================================================================

let wasmModule: typeof import('../pkg/libbitsub') | null = null;
let wasmInitPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module. Must be called before using any rendering functions.
 * Can be called early to pre-load the WASM module before it's needed.
 */
export async function initWasm(): Promise<void> {
    if (wasmModule) return;
    if (wasmInitPromise) return wasmInitPromise;
    
    wasmInitPromise = (async () => {
        const mod = await import('../pkg/libbitsub');
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
function getWasm(): typeof import('../pkg/libbitsub') {
    if (!wasmModule) {
        throw new Error('WASM module not initialized. Call initWasm() first.');
    }
    return wasmModule;
}

// Pre-initialize WASM module on first import (non-blocking)
if (typeof window !== 'undefined') {
    setTimeout(() => {
        initWasm().catch(err => console.warn('[libbitsub] WASM pre-init failed:', err));
    }, 100);
}

// =============================================================================
// Worker Management
// =============================================================================

interface CompositionData {
    rgba: Uint8Array;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface FrameData {
    width: number;
    height: number;
    compositions: CompositionData[];
}

type WorkerRequest =
    | { type: 'init'; wasmUrl: string }
    | { type: 'loadPgs'; data: ArrayBuffer }
    | { type: 'loadVobSub'; idxContent: string; subData: ArrayBuffer }
    | { type: 'loadVobSubOnly'; subData: ArrayBuffer }
    | { type: 'renderPgsAtIndex'; index: number }
    | { type: 'renderVobSubAtIndex'; index: number }
    | { type: 'getPgsTimestamps' }
    | { type: 'getVobSubTimestamps' }
    | { type: 'clearPgsCache' }
    | { type: 'clearVobSubCache' }
    | { type: 'disposePgs' }
    | { type: 'disposeVobSub' };

type WorkerResponse =
    | { type: 'initComplete'; success: boolean; error?: string }
    | { type: 'pgsLoaded'; count: number; byteLength: number }
    | { type: 'vobSubLoaded'; count: number }
    | { type: 'pgsFrame'; frame: FrameData | null }
    | { type: 'vobSubFrame'; frame: FrameData | null }
    | { type: 'pgsTimestamps'; timestamps: Float64Array }
    | { type: 'vobSubTimestamps'; timestamps: Float64Array }
    | { type: 'cleared' }
    | { type: 'disposed' }
    | { type: 'error'; message: string };

let sharedWorker: Worker | null = null;
let workerInitPromise: Promise<Worker> | null = null;
let messageId = 0;
const pendingCallbacks = new Map<number, { 
    resolve: (response: WorkerResponse) => void; 
    reject: (error: Error) => void;
}>();

/** Check if Web Workers are available. */
function isWorkerAvailable(): boolean {
    return typeof Worker !== 'undefined' && typeof window !== 'undefined' && typeof Blob !== 'undefined';
}

/** Get the WASM file URL. */
function getWasmUrl(): string {
    try {
        const baseUrl = new URL('.', import.meta.url).href;
        return new URL('../pkg/libbitsub_bg.wasm', baseUrl).href;
    } catch {
        return '/pkg/libbitsub_bg.wasm';
    }
}

/** Create inline worker script. */
function createWorkerScript(): string {
    return `
let wasmModule = null;
let pgsParser = null;
let vobSubParser = null;

async function initWasm(wasmUrl) {
    if (wasmModule) return;
    const response = await fetch(wasmUrl);
    const wasmBytes = await response.arrayBuffer();
    const jsGlueUrl = wasmUrl.replace('.wasm', '.js');
    const mod = await import(jsGlueUrl);
    await mod.default(wasmBytes);
    wasmModule = mod;
}

function convertFrame(frame, isVobSub) {
    const compositions = [];
    if (isVobSub) {
        const rgba = frame.getRgba();
        if (frame.width > 0 && frame.height > 0 && rgba.length === frame.width * frame.height * 4) {
            const rgbaCopy = new Uint8Array(rgba.length);
            rgbaCopy.set(rgba);
            compositions.push({ rgba: rgbaCopy, x: frame.x, y: frame.y, width: frame.width, height: frame.height });
        }
        return { width: frame.screenWidth, height: frame.screenHeight, compositions };
    }
    for (let i = 0; i < frame.compositionCount; i++) {
        const comp = frame.getComposition(i);
        if (!comp) continue;
        const rgba = comp.getRgba();
        if (comp.width > 0 && comp.height > 0 && rgba.length === comp.width * comp.height * 4) {
            const rgbaCopy = new Uint8Array(rgba.length);
            rgbaCopy.set(rgba);
            compositions.push({ rgba: rgbaCopy, x: comp.x, y: comp.y, width: comp.width, height: comp.height });
        }
    }
    return { width: frame.width, height: frame.height, compositions };
}

function postResponse(response, transfer, id) {
    if (id !== undefined) response._id = id;
    self.postMessage(response, transfer?.length ? transfer : undefined);
}

self.onmessage = async function(event) {
    const { _id, ...request } = event.data;
    try {
        switch (request.type) {
            case 'init':
                await initWasm(request.wasmUrl);
                postResponse({ type: 'initComplete', success: true }, [], _id);
                break;
            case 'loadPgs':
                pgsParser = new wasmModule.PgsParser();
                const pgsCount = pgsParser.parse(new Uint8Array(request.data));
                postResponse({ type: 'pgsLoaded', count: pgsCount, byteLength: request.data.byteLength }, [], _id);
                break;
            case 'loadVobSub':
                vobSubParser = new wasmModule.VobSubParser();
                vobSubParser.loadFromData(request.idxContent, new Uint8Array(request.subData));
                postResponse({ type: 'vobSubLoaded', count: vobSubParser.count }, [], _id);
                break;
            case 'loadVobSubOnly':
                vobSubParser = new wasmModule.VobSubParser();
                vobSubParser.loadFromSubOnly(new Uint8Array(request.subData));
                postResponse({ type: 'vobSubLoaded', count: vobSubParser.count }, [], _id);
                break;
            case 'renderPgsAtIndex': {
                if (!pgsParser) { postResponse({ type: 'pgsFrame', frame: null }, [], _id); break; }
                const frame = pgsParser.renderAtIndex(request.index);
                if (!frame) { postResponse({ type: 'pgsFrame', frame: null }, [], _id); break; }
                const frameData = convertFrame(frame, false);
                postResponse({ type: 'pgsFrame', frame: frameData }, frameData.compositions.map(c => c.rgba.buffer), _id);
                break;
            }
            case 'renderVobSubAtIndex': {
                if (!vobSubParser) { postResponse({ type: 'vobSubFrame', frame: null }, [], _id); break; }
                const frame = vobSubParser.renderAtIndex(request.index);
                if (!frame) { postResponse({ type: 'vobSubFrame', frame: null }, [], _id); break; }
                const frameData = convertFrame(frame, true);
                postResponse({ type: 'vobSubFrame', frame: frameData }, frameData.compositions.map(c => c.rgba.buffer), _id);
                break;
            }
            case 'getPgsTimestamps':
                postResponse({ type: 'pgsTimestamps', timestamps: pgsParser?.getTimestamps() ?? new Float64Array(0) }, [], _id);
                break;
            case 'getVobSubTimestamps':
                postResponse({ type: 'vobSubTimestamps', timestamps: vobSubParser?.getTimestamps() ?? new Float64Array(0) }, [], _id);
                break;
            case 'clearPgsCache':
                pgsParser?.clearCache();
                postResponse({ type: 'cleared' }, [], _id);
                break;
            case 'clearVobSubCache':
                vobSubParser?.clearCache();
                postResponse({ type: 'cleared' }, [], _id);
                break;
            case 'disposePgs':
                pgsParser?.free(); pgsParser = null;
                postResponse({ type: 'disposed' }, [], _id);
                break;
            case 'disposeVobSub':
                vobSubParser?.free(); vobSubParser = null;
                postResponse({ type: 'disposed' }, [], _id);
                break;
        }
    } catch (error) {
        postResponse({ type: 'error', message: error instanceof Error ? error.message : String(error) }, [], _id);
    }
};`;
}

/** Create or get the shared worker instance. */
function getOrCreateWorker(): Promise<Worker> {
    if (sharedWorker) return Promise.resolve(sharedWorker);
    if (workerInitPromise) return workerInitPromise;
    
    workerInitPromise = new Promise((resolve, reject) => {
        try {
            const blob = new Blob([createWorkerScript()], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            const worker = new Worker(workerUrl, { type: 'module' });
            
            worker.onmessage = (event: MessageEvent<WorkerResponse & { _id?: number }>) => {
                const { _id, ...response } = event.data;
                if (_id !== undefined) {
                    const callback = pendingCallbacks.get(_id);
                    if (callback) {
                        pendingCallbacks.delete(_id);
                        callback.resolve(response as WorkerResponse);
                    }
                }
            };
            
            worker.onerror = (error) => {
                console.error('[libbitsub] Worker error:', error);
                if (workerInitPromise) {
                    workerInitPromise = null;
                    reject(error);
                }
            };
            
            sharedWorker = worker;
            
            sendToWorker({ type: 'init', wasmUrl: getWasmUrl() })
                .then(() => { URL.revokeObjectURL(workerUrl); resolve(worker); })
                .catch((err) => { URL.revokeObjectURL(workerUrl); sharedWorker = null; workerInitPromise = null; reject(err); });
        } catch (error) {
            workerInitPromise = null;
            reject(error);
        }
    });
    
    return workerInitPromise;
}

/** Send a message to the worker. */
function sendToWorker(request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        if (!sharedWorker) {
            reject(new Error('Worker not initialized'));
            return;
        }
        
        const id = ++messageId;
        pendingCallbacks.set(id, { resolve, reject });
        
        const transfers: Transferable[] = [];
        if ('data' in request && request.data instanceof ArrayBuffer) transfers.push(request.data);
        if ('subData' in request && request.subData instanceof ArrayBuffer) transfers.push(request.subData);
        
        sharedWorker.postMessage({ ...request, _id: id }, transfers);
    });
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Binary search for timestamp index. */
function binarySearchTimestamp(timestamps: Float64Array, timeMs: number): number {
    if (timestamps.length === 0) return -1;
    
    let left = 0;
    let right = timestamps.length - 1;
    let result = -1;
    
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (timestamps[mid] <= timeMs) {
            result = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    
    return result;
}

/** Convert worker frame data to SubtitleData. */
function convertFrameData(frame: FrameData): SubtitleData {
    const compositionData: SubtitleCompositionData[] = frame.compositions.map(comp => {
        const clampedData = new Uint8ClampedArray(comp.rgba.length);
        clampedData.set(comp.rgba);
        return {
            pixelData: new ImageData(clampedData, comp.width, comp.height),
            x: comp.x,
            y: comp.y,
        };
    });
    
    return { width: frame.width, height: frame.height, compositionData };
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
    protected lastRenderedIndex: number = -1;
    protected lastRenderedTime: number = -1;
    protected disposed: boolean = false;
    protected resizeObserver: ResizeObserver | null = null;

    constructor(options: VideoSubtitleOptions) {
        this.video = options.video;
        this.subUrl = options.subUrl;
    }
    
    /** Start initialization. */
    protected startInit(): void {
        this.init();
    }

    /** Initialize the renderer. */
    protected async init(): Promise<void> {
        await initWasm();
        this.createCanvas();
        await new Promise(resolve => setTimeout(resolve, 0));
        await this.loadSubtitles();
        this.startRenderLoop();
    }

    /** Create the canvas overlay positioned over the video. */
    protected createCanvas(): void {
        this.canvas = document.createElement('canvas');
        Object.assign(this.canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            pointerEvents: 'none',
            width: '100%',
            height: '100%',
            zIndex: '10',
        });
        
        const parent = this.video.parentElement;
        if (parent) {
            if (window.getComputedStyle(parent).position === 'static') {
                parent.style.position = 'relative';
            }
            parent.appendChild(this.canvas);
        }
        
        this.ctx = this.canvas.getContext('2d');
        this.updateCanvasSize();
        
        this.resizeObserver = new ResizeObserver(() => this.updateCanvasSize());
        this.resizeObserver.observe(this.video);
        this.video.addEventListener('loadedmetadata', () => this.updateCanvasSize());
        this.video.addEventListener('seeked', () => {
            this.lastRenderedIndex = -1;
            this.lastRenderedTime = -1;
            this.onSeek();
        });
    }
    
    /** Called when video seeks. */
    protected onSeek(): void {}

    /** Update canvas size to match video. */
    protected updateCanvasSize(): void {
        if (!this.canvas) return;
        
        const rect = this.video.getBoundingClientRect();
        const width = rect.width > 0 ? rect.width : (this.video.videoWidth || 1920);
        const height = rect.height > 0 ? rect.height : (this.video.videoHeight || 1080);
        
        this.canvas.width = width * window.devicePixelRatio;
        this.canvas.height = height * window.devicePixelRatio;
        this.lastRenderedIndex = -1;
        this.lastRenderedTime = -1;
    }

    protected abstract loadSubtitles(): Promise<void>;
    protected abstract renderAtTime(time: number): SubtitleData | undefined;
    protected abstract findCurrentIndex(time: number): number;
    protected abstract renderAtIndex(index: number): SubtitleData | undefined;

    /** Start the render loop. */
    protected startRenderLoop(): void {
        const render = () => {
            if (this.disposed) return;
            
            if (this.isLoaded) {
                const currentTime = this.video.currentTime;
                const currentIndex = this.findCurrentIndex(currentTime);
                
                const shouldRender = 
                    currentIndex !== this.lastRenderedIndex ||
                    this.lastRenderedIndex < 0 ||
                    currentTime < this.lastRenderedTime - 0.5;
                
                if (shouldRender) {
                    this.renderFrame(currentTime, currentIndex);
                    this.lastRenderedIndex = currentIndex;
                    this.lastRenderedTime = currentTime;
                }
            }
            
            this.animationFrameId = requestAnimationFrame(render);
        };
        
        this.animationFrameId = requestAnimationFrame(render);
    }

    /** Render a subtitle frame to the canvas. */
    protected renderFrame(time: number, index: number): void {
        if (!this.ctx || !this.canvas) return;
        
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (index < 0) return;
        
        const data = this.renderAtIndex(index);
        if (!data || data.compositionData.length === 0) return;
        
        const scaleX = this.canvas.width / data.width;
        const scaleY = this.canvas.height / data.height;
        
        if (this.lastRenderedIndex < 0) {
            console.log(`[libbitsub] First render at ${time}s (index ${index}):`, {
                canvasSize: { w: this.canvas.width, h: this.canvas.height },
                subtitleSize: { w: data.width, h: data.height },
                compositionCount: data.compositionData.length,
                scale: { x: scaleX, y: scaleY }
            });
        }
        
        for (const comp of data.compositionData) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = comp.pixelData.width;
            tempCanvas.height = comp.pixelData.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) continue;
            
            tempCtx.putImageData(comp.pixelData, 0, 0);
            this.ctx.drawImage(
                tempCanvas, 
                comp.x * scaleX, 
                comp.y * scaleY, 
                comp.pixelData.width * scaleX, 
                comp.pixelData.height * scaleY
            );
        }
    }

    /** Dispose of all resources. */
    dispose(): void {
        this.disposed = true;
        
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        
        this.canvas?.parentElement?.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
    }
}

/** Shared worker state for video renderers. */
interface WorkerRendererState {
    useWorker: boolean;
    workerReady: boolean;
    timestamps: Float64Array;
    frameCache: Map<number, SubtitleData | null>;
    pendingRenders: Map<number, Promise<SubtitleData | null>>;
}

/** Create initial worker state. */
function createWorkerState(): WorkerRendererState {
    return {
        useWorker: isWorkerAvailable(),
        workerReady: false,
        timestamps: new Float64Array(0),
        frameCache: new Map(),
        pendingRenders: new Map(),
    };
}

/**
 * High-level PGS subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */
export class PgsRenderer extends BaseVideoSubtitleRenderer {
    private pgsParser: PgsParser | null = null;
    private state = createWorkerState();

    constructor(options: VideoSubtitleOptions) {
        super(options);
        this.startInit();
    }

    protected async loadSubtitles(): Promise<void> {
        try {
            const response = await fetch(this.subUrl);
            if (!response.ok) throw new Error(`Failed to fetch subtitle: ${response.status}`);
            
            const arrayBuffer = await response.arrayBuffer();
            
            if (this.state.useWorker) {
                try {
                    await getOrCreateWorker();
                    const loadResponse = await sendToWorker({ type: 'loadPgs', data: arrayBuffer });
                    
                    if (loadResponse.type === 'pgsLoaded') {
                        this.state.workerReady = true;
                        const tsResponse = await sendToWorker({ type: 'getPgsTimestamps' });
                        if (tsResponse.type === 'pgsTimestamps') {
                            this.state.timestamps = tsResponse.timestamps;
                        }
                        this.isLoaded = true;
                        console.log(`[libbitsub] PGS loaded (worker): ${loadResponse.count} display sets from ${loadResponse.byteLength} bytes`);
                    } else if (loadResponse.type === 'error') {
                        throw new Error(loadResponse.message);
                    }
                } catch (workerError) {
                    console.warn('[libbitsub] Worker failed, falling back to main thread:', workerError);
                    this.state.useWorker = false;
                    await this.loadOnMainThread(new Uint8Array(arrayBuffer));
                }
            } else {
                await this.loadOnMainThread(new Uint8Array(arrayBuffer));
            }
        } catch (error) {
            console.error('Failed to load PGS subtitles:', error);
        }
    }
    
    private async loadOnMainThread(data: Uint8Array): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 0));
        this.pgsParser = new PgsParser();
        const count = this.pgsParser.load(data);
        this.state.timestamps = this.pgsParser.getTimestamps();
        this.isLoaded = true;
        console.log(`[libbitsub] PGS loaded (main thread): ${count} display sets from ${data.byteLength} bytes`);
    }

    protected renderAtTime(time: number): SubtitleData | undefined {
        const index = this.findCurrentIndex(time);
        return index < 0 ? undefined : this.renderAtIndex(index);
    }
    
    protected findCurrentIndex(time: number): number {
        if (this.state.useWorker && this.state.workerReady) {
            return binarySearchTimestamp(this.state.timestamps, time * 1000);
        }
        return this.pgsParser?.findIndexAtTimestamp(time) ?? -1;
    }
    
    protected renderAtIndex(index: number): SubtitleData | undefined {
        if (this.state.useWorker && this.state.workerReady) {
            if (this.state.frameCache.has(index)) {
                return this.state.frameCache.get(index) ?? undefined;
            }
            
            if (!this.state.pendingRenders.has(index)) {
                const renderPromise = sendToWorker({ type: 'renderPgsAtIndex', index })
                    .then(response => response.type === 'pgsFrame' && response.frame ? convertFrameData(response.frame) : null);
                
                this.state.pendingRenders.set(index, renderPromise);
                renderPromise.then(result => {
                    this.state.frameCache.set(index, result);
                    this.state.pendingRenders.delete(index);
                    if (this.lastRenderedIndex === -1 || this.lastRenderedIndex === index) {
                        this.lastRenderedIndex = -1;
                    }
                });
            }
            return undefined;
        }
        return this.pgsParser?.renderAtIndex(index);
    }
    
    protected onSeek(): void {
        this.state.frameCache.clear();
        this.state.pendingRenders.clear();
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'clearPgsCache' }).catch(() => {});
        }
        this.pgsParser?.clearCache();
    }

    dispose(): void {
        super.dispose();
        this.state.frameCache.clear();
        this.state.pendingRenders.clear();
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'disposePgs' }).catch(() => {});
        }
        this.pgsParser?.dispose();
        this.pgsParser = null;
    }
}

/**
 * High-level VobSub subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */
export class VobSubRenderer extends BaseVideoSubtitleRenderer {
    private vobsubParser: VobSubParserLowLevel | null = null;
    private idxUrl: string;
    private state = createWorkerState();

    constructor(options: VideoVobSubOptions) {
        super(options);
        this.idxUrl = options.idxUrl || options.subUrl.replace(/\.sub$/i, '.idx');
        this.startInit();
    }

    protected async loadSubtitles(): Promise<void> {
        try {
            console.log(`[libbitsub] Loading VobSub: ${this.subUrl}, ${this.idxUrl}`);
            
            const [subResponse, idxResponse] = await Promise.all([
                fetch(this.subUrl),
                fetch(this.idxUrl),
            ]);

            if (!subResponse.ok) throw new Error(`Failed to fetch .sub file: ${subResponse.status}`);
            if (!idxResponse.ok) throw new Error(`Failed to fetch .idx file: ${idxResponse.status}`);

            const subArrayBuffer = await subResponse.arrayBuffer();
            const idxData = await idxResponse.text();
            
            console.log(`[libbitsub] VobSub files loaded: .sub=${subArrayBuffer.byteLength} bytes, .idx=${idxData.length} chars`);

            if (this.state.useWorker) {
                try {
                    await getOrCreateWorker();
                    const loadResponse = await sendToWorker({ 
                        type: 'loadVobSub', 
                        idxContent: idxData,
                        subData: subArrayBuffer 
                    });
                    
                    if (loadResponse.type === 'vobSubLoaded') {
                        this.state.workerReady = true;
                        const tsResponse = await sendToWorker({ type: 'getVobSubTimestamps' });
                        if (tsResponse.type === 'vobSubTimestamps') {
                            this.state.timestamps = tsResponse.timestamps;
                        }
                        this.isLoaded = true;
                        console.log(`[libbitsub] VobSub loaded (worker): ${loadResponse.count} subtitle entries`);
                    } else if (loadResponse.type === 'error') {
                        throw new Error(loadResponse.message);
                    }
                } catch (workerError) {
                    console.warn('[libbitsub] Worker failed, falling back to main thread:', workerError);
                    this.state.useWorker = false;
                    await this.loadOnMainThread(idxData, new Uint8Array(subArrayBuffer));
                }
            } else {
                await this.loadOnMainThread(idxData, new Uint8Array(subArrayBuffer));
            }
        } catch (error) {
            console.error('Failed to load VobSub subtitles:', error);
        }
    }
    
    private async loadOnMainThread(idxData: string, subData: Uint8Array): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, 0));
        this.vobsubParser = new VobSubParserLowLevel();
        this.vobsubParser.loadFromData(idxData, subData);
        this.state.timestamps = this.vobsubParser.getTimestamps();
        console.log(`[libbitsub] VobSub loaded (main thread): ${this.vobsubParser.count} subtitle entries`);
        this.isLoaded = true;
    }

    protected renderAtTime(time: number): SubtitleData | undefined {
        const index = this.findCurrentIndex(time);
        return index < 0 ? undefined : this.renderAtIndex(index);
    }
    
    protected findCurrentIndex(time: number): number {
        if (this.state.useWorker && this.state.workerReady) {
            return binarySearchTimestamp(this.state.timestamps, time * 1000);
        }
        return this.vobsubParser?.findIndexAtTimestamp(time) ?? -1;
    }
    
    protected renderAtIndex(index: number): SubtitleData | undefined {
        if (this.state.useWorker && this.state.workerReady) {
            if (this.state.frameCache.has(index)) {
                return this.state.frameCache.get(index) ?? undefined;
            }
            
            if (!this.state.pendingRenders.has(index)) {
                const renderPromise = sendToWorker({ type: 'renderVobSubAtIndex', index })
                    .then(response => response.type === 'vobSubFrame' && response.frame ? convertFrameData(response.frame) : null);
                
                this.state.pendingRenders.set(index, renderPromise);
                renderPromise.then(result => {
                    this.state.frameCache.set(index, result);
                    this.state.pendingRenders.delete(index);
                    if (this.lastRenderedIndex === -1 || this.lastRenderedIndex === index) {
                        this.lastRenderedIndex = -1;
                    }
                });
            }
            return undefined;
        }
        return this.vobsubParser?.renderAtIndex(index);
    }
    
    protected onSeek(): void {
        this.state.frameCache.clear();
        this.state.pendingRenders.clear();
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'clearVobSubCache' }).catch(() => {});
        }
        this.vobsubParser?.clearCache();
    }

    dispose(): void {
        super.dispose();
        this.state.frameCache.clear();
        this.state.pendingRenders.clear();
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'disposeVobSub' }).catch(() => {});
        }
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
