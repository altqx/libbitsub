/**
 * High-level video-integrated subtitle renderers for libbitsub.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */

import type { SubtitleData, VideoSubtitleOptions, VideoVobSubOptions } from './types';
import { initWasm } from './wasm';
import { getOrCreateWorker, sendToWorker } from './worker';
import { binarySearchTimestamp, convertFrameData, createWorkerState } from './utils';
import { PgsParser, VobSubParserLowLevel } from './parsers';

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
