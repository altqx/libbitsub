/**
 * Web Worker management for libbitsub.
 * Handles off-main-thread subtitle parsing and rendering.
 */

import type { WorkerRequest, WorkerResponse } from './types';
import { getWasmUrl } from './wasm';

let sharedWorker: Worker | null = null;
let workerInitPromise: Promise<Worker> | null = null;
let messageId = 0;

const pendingCallbacks = new Map<number, { 
    resolve: (response: WorkerResponse) => void; 
    reject: (error: Error) => void;
}>();

/** Check if Web Workers are available. */
export function isWorkerAvailable(): boolean {
    return typeof Worker !== 'undefined' && typeof window !== 'undefined' && typeof Blob !== 'undefined';
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
export function getOrCreateWorker(): Promise<Worker> {
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

/** Default timeout for worker operations (30 seconds for large files) */
const WORKER_TIMEOUT = 30000;

/** Send a message to the worker with timeout support. */
export function sendToWorker(request: WorkerRequest, timeout = WORKER_TIMEOUT): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        if (!sharedWorker) {
            reject(new Error('Worker not initialized'));
            return;
        }
        
        const id = ++messageId;
        
        // Set up timeout
        const timeoutId = setTimeout(() => {
            pendingCallbacks.delete(id);
            reject(new Error(`Worker operation timed out after ${timeout}ms`));
        }, timeout);
        
        pendingCallbacks.set(id, { 
            resolve: (response) => {
                clearTimeout(timeoutId);
                resolve(response);
            }, 
            reject: (error) => {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
        
        const transfers: Transferable[] = [];
        if ('data' in request && request.data instanceof ArrayBuffer) transfers.push(request.data);
        if ('subData' in request && request.subData instanceof ArrayBuffer) transfers.push(request.subData);
        
        sharedWorker.postMessage({ ...request, _id: id }, transfers);
    });
}