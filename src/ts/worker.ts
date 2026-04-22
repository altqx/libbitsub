/**
 * Web Worker management for libbitsub.
 * Handles off-main-thread subtitle parsing and rendering.
 */

import type { WorkerRequest, WorkerResponse } from './types'
import { getWasmUrl } from './wasm'

let sharedWorker: Worker | null = null
let workerInitPromise: Promise<Worker> | null = null
let messageId = 0

const pendingCallbacks = new Map<
    number,
    {
        resolve: (response: WorkerResponse) => void
        reject: (error: Error) => void
    }
>()

/** Check if Web Workers are available. */
export function isWorkerAvailable(): boolean {
    return typeof Worker !== 'undefined' && typeof window !== 'undefined' && typeof Blob !== 'undefined'
}

/** Create inline worker script with embedded WASM loader. */
function createWorkerScript(): string {
    return `
let wasmModule = null;
let wasm;
let cachedUint8Memory = null;
let WASM_VECTOR_LEN = 0;
let cachedTextEncoder = new TextEncoder();
let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const pgsParsers = new Map();
const vobSubParsers = new Map();

function getUint8Memory() {
    if (cachedUint8Memory === null || cachedUint8Memory.byteLength === 0) {
        cachedUint8Memory = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory;
}

function passArray8ToWasm(arg) {
    const ptr = wasm.__wbindgen_malloc(arg.length);
    getUint8Memory().set(arg, ptr);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

const encodeString = typeof cachedTextEncoder.encodeInto === 'function'
    ? function(arg, view) { return cachedTextEncoder.encodeInto(arg, view); }
    : function(arg, view) {
            const buf = cachedTextEncoder.encode(arg);
            view.set(buf);
            return { read: arg.length, written: buf.length };
        };

function passStringToWasm(arg) {
    let len = arg.length;
    let ptr = wasm.__wbindgen_malloc(len);
    const mem = getUint8Memory();
    let offset = 0;
    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) arg = arg.slice(offset);
        ptr = wasm.__wbindgen_realloc(ptr, len, len = offset + arg.length * 3);
        const view = getUint8Memory().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);
        offset += ret.written;
    }
    WASM_VECTOR_LEN = offset;
    return ptr;
}

function getStringFromWasm(ptr, len) {
    return cachedTextDecoder.decode(getUint8Memory().subarray(ptr, ptr + len));
}

function buildPgsMetadata(parser) {
    return {
        format: 'pgs',
        cueCount: parser.count,
        screenWidth: parser.screenWidth || 0,
        screenHeight: parser.screenHeight || 0
    };
}

function buildVobSubMetadata(parser) {
    return {
        format: 'vobsub',
        cueCount: parser.count,
        screenWidth: parser.screenWidth || 0,
        screenHeight: parser.screenHeight || 0,
        language: parser.language || '',
        trackId: parser.trackId || '',
        hasIdxMetadata: !!parser.hasIdxMetadata
    };
}

function disposeSession(sessionId) {
    const pgsParser = pgsParsers.get(sessionId);
    if (pgsParser) {
        pgsParser.free();
        pgsParsers.delete(sessionId);
    }
    const vobSubParser = vobSubParsers.get(sessionId);
    if (vobSubParser) {
        vobSubParser.free();
        vobSubParsers.delete(sessionId);
    }
}

async function initWasm(wasmUrl) {
    if (wasm) return;

    const response = await fetch(wasmUrl);
    if (!response.ok) {
        throw new Error('Failed to fetch WASM: ' + response.status);
    }

    const wasmBytes = await response.arrayBuffer();
    const result = await WebAssembly.instantiate(wasmBytes, {
        __wbindgen_placeholder__: {
            __wbindgen_throw: function(ptr, len) {
                throw new Error(getStringFromWasm(ptr, len));
            }
        }
    });
    wasm = result.instance.exports;

    wasmModule = {
        PgsParser: class {
            constructor() { this.ptr = wasm.pgsparser_new(); }
            parse(data) {
                const ptr = passArray8ToWasm(data);
                return wasm.pgsparser_parse(this.ptr, ptr, WASM_VECTOR_LEN);
            }
            getTimestamps() { return wasm.pgsparser_getTimestamps(this.ptr); }
            renderAtIndex(idx) { return wasm.pgsparser_renderAtIndex(this.ptr, idx); }
            findIndexAtTimestamp(ts) { return wasm.pgsparser_findIndexAtTimestamp(this.ptr, ts); }
            clearCache() { wasm.pgsparser_clearCache(this.ptr); }
            free() { wasm.pgsparser_free(this.ptr); }
            get count() { return wasm.pgsparser_count(this.ptr); }
            get screenWidth() { return wasm.pgsparser_screenWidth(this.ptr); }
            get screenHeight() { return wasm.pgsparser_screenHeight(this.ptr); }
        },
        VobSubParser: class {
            constructor() { this.ptr = wasm.vobsubparser_new(); }
            loadFromData(idx, sub) {
                const idxPtr = passStringToWasm(idx);
                const idxLen = WASM_VECTOR_LEN;
                const subPtr = passArray8ToWasm(sub);
                wasm.vobsubparser_loadFromData(this.ptr, idxPtr, idxLen, subPtr, sub.length);
            }
            loadFromMks(sub) {
                const ptr = passArray8ToWasm(sub);
                wasm.vobsubparser_loadFromMks(this.ptr, ptr, WASM_VECTOR_LEN);
            }
            loadFromSubOnly(sub) {
                const ptr = passArray8ToWasm(sub);
                wasm.vobsubparser_loadFromSubOnly(this.ptr, ptr, WASM_VECTOR_LEN);
            }
            getTimestamps() { return wasm.vobsubparser_getTimestamps(this.ptr); }
            renderAtIndex(idx) { return wasm.vobsubparser_renderAtIndex(this.ptr, idx); }
            findIndexAtTimestamp(ts) { return wasm.vobsubparser_findIndexAtTimestamp(this.ptr, ts); }
            clearCache() { wasm.vobsubparser_clearCache(this.ptr); }
            free() { wasm.vobsubparser_free(this.ptr); }
            setDebandEnabled(enabled) { wasm.vobsubparser_setDebandEnabled(this.ptr, enabled); }
            setDebandThreshold(threshold) { wasm.vobsubparser_setDebandThreshold(this.ptr, threshold); }
            setDebandRange(range) { wasm.vobsubparser_setDebandRange(this.ptr, range); }
            get count() { return wasm.vobsubparser_count(this.ptr); }
            get screenWidth() { return wasm.vobsubparser_screenWidth(this.ptr); }
            get screenHeight() { return wasm.vobsubparser_screenHeight(this.ptr); }
            get language() { return wasm.vobsubparser_language(this.ptr); }
            get trackId() { return wasm.vobsubparser_trackId(this.ptr); }
            get hasIdxMetadata() { return !!wasm.vobsubparser_hasIdxMetadata(this.ptr); }
        }
    };
}

function convertFrame(frame, isVobSub) {
    const compositions = [];
    if (isVobSub) {
        const rgba = frame.getRgba();
        if (frame.width > 0 && frame.height > 0 && rgba.length === frame.width * frame.height * 4) {
            compositions.push({ rgba, x: frame.x, y: frame.y, width: frame.width, height: frame.height });
        }
        return { width: frame.screenWidth, height: frame.screenHeight, compositions };
    }

    for (let i = 0; i < frame.compositionCount; i++) {
        const comp = frame.getComposition(i);
        if (!comp) continue;
        const rgba = comp.getRgba();
        if (comp.width > 0 && comp.height > 0 && rgba.length === comp.width * comp.height * 4) {
            compositions.push({ rgba, x: comp.x, y: comp.y, width: comp.width, height: comp.height });
        }
    }

    return { width: frame.width, height: frame.height, compositions };
}

function postResponse(response, transfer, id) {
    if (id !== undefined) response._id = id;
    self.postMessage(response, transfer && transfer.length > 0 ? transfer : undefined);
}

self.onmessage = async function(event) {
    const { _id, ...request } = event.data;

    try {
        switch (request.type) {
            case 'init': {
                await initWasm(request.wasmUrl);
                postResponse({ type: 'initComplete', success: true }, [], _id);
                break;
            }
            case 'loadPgs': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.PgsParser();
                const count = parser.parse(new Uint8Array(request.data));
                const timestamps = parser.getTimestamps();
                pgsParsers.set(request.sessionId, parser);
                postResponse(
                    { type: 'pgsLoaded', count, byteLength: request.data.byteLength, metadata: buildPgsMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'loadVobSub': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.VobSubParser();
                parser.loadFromData(request.idxContent, new Uint8Array(request.subData));
                const timestamps = parser.getTimestamps();
                vobSubParsers.set(request.sessionId, parser);
                postResponse(
                    { type: 'vobSubLoaded', count: parser.count, metadata: buildVobSubMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'loadVobSubMks': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.VobSubParser();
                parser.loadFromMks(new Uint8Array(request.subData));
                const timestamps = parser.getTimestamps();
                vobSubParsers.set(request.sessionId, parser);
                postResponse(
                    { type: 'vobSubLoaded', count: parser.count, metadata: buildVobSubMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'loadVobSubOnly': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.VobSubParser();
                parser.loadFromSubOnly(new Uint8Array(request.subData));
                const timestamps = parser.getTimestamps();
                vobSubParsers.set(request.sessionId, parser);
                postResponse(
                    { type: 'vobSubLoaded', count: parser.count, metadata: buildVobSubMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'renderPgsAtIndex': {
                const parser = pgsParsers.get(request.sessionId);
                if (!parser) { postResponse({ type: 'pgsFrame', frame: null }, [], _id); break; }
                const frame = parser.renderAtIndex(request.index);
                const renderIssue = parser.lastRenderIssue || '';
                if (!frame) { postResponse({ type: 'pgsFrame', frame: null, renderIssue }, [], _id); break; }
                const frameData = convertFrame(frame, false);
                postResponse({ type: 'pgsFrame', frame: frameData, renderIssue }, frameData.compositions.map((c) => c.rgba.buffer), _id);
                break;
            }
            case 'renderVobSubAtIndex': {
                const parser = vobSubParsers.get(request.sessionId);
                if (!parser) { postResponse({ type: 'vobSubFrame', frame: null }, [], _id); break; }
                const frame = parser.renderAtIndex(request.index);
                const renderIssue = parser.lastRenderIssue || '';
                if (!frame) { postResponse({ type: 'vobSubFrame', frame: null, renderIssue }, [], _id); break; }
                const frameData = convertFrame(frame, true);
                postResponse({ type: 'vobSubFrame', frame: frameData, renderIssue }, frameData.compositions.map((c) => c.rgba.buffer), _id);
                break;
            }
            case 'findPgsIndex': {
                const parser = pgsParsers.get(request.sessionId);
                postResponse({ type: 'pgsIndex', index: parser ? parser.findIndexAtTimestamp(request.timeMs) : -1 }, [], _id);
                break;
            }
            case 'findVobSubIndex': {
                const parser = vobSubParsers.get(request.sessionId);
                postResponse({ type: 'vobSubIndex', index: parser ? parser.findIndexAtTimestamp(request.timeMs) : -1 }, [], _id);
                break;
            }
            case 'getPgsTimestamps': {
                const parser = pgsParsers.get(request.sessionId);
                postResponse({ type: 'pgsTimestamps', timestamps: parser ? parser.getTimestamps() : new Float64Array(0) }, [], _id);
                break;
            }
            case 'getVobSubTimestamps': {
                const parser = vobSubParsers.get(request.sessionId);
                postResponse({ type: 'vobSubTimestamps', timestamps: parser ? parser.getTimestamps() : new Float64Array(0) }, [], _id);
                break;
            }
            case 'clearPgsCache': {
                pgsParsers.get(request.sessionId)?.clearCache();
                postResponse({ type: 'cleared' }, [], _id);
                break;
            }
            case 'clearVobSubCache': {
                vobSubParsers.get(request.sessionId)?.clearCache();
                postResponse({ type: 'cleared' }, [], _id);
                break;
            }
            case 'disposePgs': {
                const parser = pgsParsers.get(request.sessionId);
                if (parser) {
                    parser.free();
                    pgsParsers.delete(request.sessionId);
                }
                postResponse({ type: 'disposed' }, [], _id);
                break;
            }
            case 'disposeVobSub': {
                const parser = vobSubParsers.get(request.sessionId);
                if (parser) {
                    parser.free();
                    vobSubParsers.delete(request.sessionId);
                }
                postResponse({ type: 'disposed' }, [], _id);
                break;
            }
            case 'setVobSubDebandEnabled': {
                vobSubParsers.get(request.sessionId)?.setDebandEnabled(request.enabled);
                postResponse({ type: 'debandSet' }, [], _id);
                break;
            }
            case 'setVobSubDebandThreshold': {
                vobSubParsers.get(request.sessionId)?.setDebandThreshold(request.threshold);
                postResponse({ type: 'debandSet' }, [], _id);
                break;
            }
            case 'setVobSubDebandRange': {
                vobSubParsers.get(request.sessionId)?.setDebandRange(request.range);
                postResponse({ type: 'debandSet' }, [], _id);
                break;
            }
        }
    } catch (error) {
        postResponse({ type: 'error', message: error instanceof Error ? error.message : String(error) }, [], _id);
    }
};`
}

/** Create or get the shared worker instance. */
export function getOrCreateWorker(): Promise<Worker> {
    if (sharedWorker) return Promise.resolve(sharedWorker)
    if (workerInitPromise) return workerInitPromise

    workerInitPromise = new Promise((resolve, reject) => {
        try {
            const blob = new Blob([createWorkerScript()], { type: 'application/javascript' })
            const workerUrl = URL.createObjectURL(blob)
            const worker = new Worker(workerUrl, { type: 'module' })

            worker.onmessage = (event: MessageEvent<WorkerResponse & { _id?: number }>) => {
                const { _id, ...response } = event.data
                if (_id !== undefined) {
                    const callback = pendingCallbacks.get(_id)
                    if (callback) {
                        pendingCallbacks.delete(_id)
                        callback.resolve(response as WorkerResponse)
                    }
                }
            }

            worker.onerror = (error) => {
                if (workerInitPromise) {
                    workerInitPromise = null
                    reject(error instanceof ErrorEvent ? new Error(error.message) : new Error(String(error)))
                }
            }

            sharedWorker = worker

            sendToWorker({ type: 'init', wasmUrl: getWasmUrl() })
                .then(() => {
                    URL.revokeObjectURL(workerUrl)
                    resolve(worker)
                })
                .catch((err) => {
                    URL.revokeObjectURL(workerUrl)
                    sharedWorker = null
                    workerInitPromise = null
                    reject(err)
                })
        } catch (error) {
            workerInitPromise = null
            reject(error instanceof Error ? error : new Error(String(error)))
        }
    })

    return workerInitPromise
}

/** Default timeout for worker operations (30 seconds for large files) */
const WORKER_TIMEOUT = 30000

/** Send a message to the worker with timeout support. */
export function sendToWorker(request: WorkerRequest, timeout = WORKER_TIMEOUT): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
        if (!sharedWorker) {
            reject(new Error('Worker not initialized'))
            return
        }

        const id = ++messageId
        const timeoutId = setTimeout(() => {
            pendingCallbacks.delete(id)
            reject(new Error(`Worker operation timed out after ${timeout}ms`))
        }, timeout)

        pendingCallbacks.set(id, {
            resolve: (response) => {
                clearTimeout(timeoutId)
                resolve(response)
            },
            reject: (error) => {
                clearTimeout(timeoutId)
                reject(error)
            }
        })

        const transfers: Transferable[] = []
        if ('data' in request && request.data instanceof ArrayBuffer) transfers.push(request.data)
        if ('subData' in request && request.subData instanceof ArrayBuffer) transfers.push(request.subData)

        sharedWorker.postMessage({ ...request, _id: id }, transfers)
    })
}
