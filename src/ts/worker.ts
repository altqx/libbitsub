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
let pgsParser = null;
let vobSubParser = null;

// Minimal WASM bindings (inlined from wasm-bindgen output)
let wasm;
let cachedUint8Memory = null;
let cachedInt32Memory = null;
let cachedFloat64Memory = null;
let WASM_VECTOR_LEN = 0;
let cachedTextEncoder = new TextEncoder();
let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

function getUint8Memory() {
    if (cachedUint8Memory === null || cachedUint8Memory.byteLength === 0) {
        cachedUint8Memory = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory;
}

function getInt32Memory() {
    if (cachedInt32Memory === null || cachedInt32Memory.byteLength === 0) {
        cachedInt32Memory = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32Memory;
}

function getFloat64Memory() {
    if (cachedFloat64Memory === null || cachedFloat64Memory.byteLength === 0) {
        cachedFloat64Memory = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64Memory;
}

function passArray8ToWasm(arg) {
    const ptr = wasm.__wbindgen_malloc(arg.length);
    getUint8Memory().set(arg, ptr);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
        return cachedTextEncoder.encodeInto(arg, view);
    }
    : function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return { read: arg.length, written: buf.length };
    });

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

async function initWasm(wasmUrl) {
    if (wasm) return;
    
    console.log('[libbitsub worker] Fetching WASM from:', wasmUrl);
    const response = await fetch(wasmUrl);
    if (!response.ok) {
        throw new Error('Failed to fetch WASM: ' + response.status);
    }
    
    // Try to load the JS glue file
    const jsGlueUrl = wasmUrl.replace('_bg.wasm', '.js').replace('.wasm', '.js');
    console.log('[libbitsub worker] Loading JS glue from:', jsGlueUrl);
    
    try {
        const mod = await import(/* webpackIgnore: true */ jsGlueUrl);
        const wasmBytes = await response.arrayBuffer();
        await mod.default(wasmBytes);
        wasmModule = mod;
        wasm = mod.__wasm || mod;
        console.log('[libbitsub worker] WASM initialized via JS glue');
    } catch (jsError) {
        console.warn('[libbitsub worker] JS glue import failed, using direct instantiation:', jsError.message);
        
        // Fallback: direct WASM instantiation (limited functionality)
        const wasmBytes = await response.arrayBuffer();
        const result = await WebAssembly.instantiate(wasmBytes, {
            __wbindgen_placeholder__: {
                __wbindgen_throw: function(ptr, len) {
                    throw new Error(getStringFromWasm(ptr, len));
                }
            }
        });
        wasm = result.instance.exports;
        
        // Create minimal module interface
        wasmModule = {
            PgsParser: class {
                constructor() { this.ptr = wasm.pgsparser_new(); }
                parse(data) {
                    const ptr = passArray8ToWasm(data);
                    return wasm.pgsparser_parse(this.ptr, ptr, WASM_VECTOR_LEN);
                }
                getTimestamps() {
                    wasm.pgsparser_get_timestamps(8, this.ptr);
                    const r0 = getInt32Memory()[8 / 4 + 0];
                    const r1 = getInt32Memory()[8 / 4 + 1];
                    return new Float64Array(getFloat64Memory().buffer, r0, r1);
                }
                renderAtIndex(idx) { return wasm.pgsparser_render_at_index(this.ptr, idx); }
                findIndexAtTimestamp(ts) { return wasm.pgsparser_find_index_at_timestamp(this.ptr, ts); }
                clearCache() { wasm.pgsparser_clear_cache(this.ptr); }
                free() { wasm.pgsparser_free(this.ptr); }
                get count() { return wasm.pgsparser_count(this.ptr); }
            },
            VobSubParser: class {
                constructor() { this.ptr = wasm.vobsubparser_new(); }
                loadFromData(idx, sub) {
                    const idxPtr = passStringToWasm(idx);
                    const subPtr = passArray8ToWasm(sub);
                    wasm.vobsubparser_load_from_data(this.ptr, idxPtr, WASM_VECTOR_LEN, subPtr, sub.length);
                }
                loadFromSubOnly(sub) {
                    const ptr = passArray8ToWasm(sub);
                    wasm.vobsubparser_load_from_sub_only(this.ptr, ptr, WASM_VECTOR_LEN);
                }
                getTimestamps() {
                    wasm.vobsubparser_get_timestamps(8, this.ptr);
                    const r0 = getInt32Memory()[8 / 4 + 0];
                    const r1 = getInt32Memory()[8 / 4 + 1];
                    return new Float64Array(getFloat64Memory().buffer, r0, r1);
                }
                renderAtIndex(idx) { return wasm.vobsubparser_render_at_index(this.ptr, idx); }
                findIndexAtTimestamp(ts) { return wasm.vobsubparser_find_index_at_timestamp(this.ptr, ts); }
                clearCache() { wasm.vobsubparser_clear_cache(this.ptr); }
                free() { wasm.vobsubparser_free(this.ptr); }
                get count() { return wasm.vobsubparser_count(this.ptr); }
            }
        };
        console.log('[libbitsub worker] WASM initialized via direct instantiation');
    }
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
};`
}

/** Create or get the shared worker instance. */
export function getOrCreateWorker(): Promise<Worker> {
  if (sharedWorker) return Promise.resolve(sharedWorker)
  if (workerInitPromise) return workerInitPromise

  workerInitPromise = new Promise((resolve, reject) => {
    try {
      console.log('[libbitsub] Creating worker...')
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
        console.error('[libbitsub] Worker error:', error)
        if (workerInitPromise) {
          workerInitPromise = null
          reject(error)
        }
      }

      sharedWorker = worker

      const wasmUrl = getWasmUrl()
      console.log('[libbitsub] Initializing worker with WASM URL:', wasmUrl)

      sendToWorker({ type: 'init', wasmUrl })
        .then(() => {
          console.log('[libbitsub] Worker initialized successfully')
          URL.revokeObjectURL(workerUrl)
          resolve(worker)
        })
        .catch((err) => {
          console.error('[libbitsub] Worker initialization failed:', err)
          URL.revokeObjectURL(workerUrl)
          sharedWorker = null
          workerInitPromise = null
          reject(err)
        })
    } catch (error) {
      console.error('[libbitsub] Failed to create worker:', error)
      workerInitPromise = null
      reject(error)
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

    // Set up timeout
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
