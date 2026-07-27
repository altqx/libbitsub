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
    worker: Worker
    requestType: WorkerRequest['type']
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
const pgsParsers = new Map();
const vobSubParsers = new Map();

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
    if (wasmModule) return;

    const jsGlueUrl = new URL(wasmUrl);
    jsGlueUrl.pathname = jsGlueUrl.pathname.replace(/_bg\.wasm$/, '.js');
    const mod = await import(jsGlueUrl.href);
    await mod.default({ module_or_path: wasmUrl });
    wasmModule = mod;
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

  const initPromise = initializeWorker()
  workerInitPromise = initPromise
  initPromise.then(
    () => {
      if (workerInitPromise === initPromise) workerInitPromise = null
    },
    () => {
      if (workerInitPromise === initPromise) workerInitPromise = null
    }
  )

  return workerInitPromise
}

async function initializeWorker(): Promise<Worker> {
  const blob = new Blob([createWorkerScript()], { type: 'application/javascript' })
  const workerUrl = URL.createObjectURL(blob)
  const worker = new Worker(workerUrl, { type: 'module' })

  worker.onmessage = (event: MessageEvent<WorkerResponse & { _id?: number }>) => {
    const { _id, ...response } = event.data
    if (_id === undefined) return

    const callback = pendingCallbacks.get(_id)
    if (!callback) return

    pendingCallbacks.delete(_id)
    if (response.type === 'error' && callback.requestType === 'init') {
      callback.reject(new Error(response.message))
    } else {
      callback.resolve(response as WorkerResponse)
    }
  }

  worker.onerror = (event) => {
    const error = event instanceof ErrorEvent ? new Error(event.message) : new Error(String(event))
    rejectWorkerCallbacks(worker, error)
    if (sharedWorker === worker) sharedWorker = null
    worker.terminate()
  }

  try {
    await sendToWorkerInstance(worker, { type: 'init', wasmUrl: getWasmUrl() })
    sharedWorker = worker
    return worker
  } catch (error) {
    const workerError = error instanceof Error ? error : new Error(String(error))
    rejectWorkerCallbacks(worker, workerError)
    if (sharedWorker === worker) sharedWorker = null
    worker.terminate()
    throw workerError
  } finally {
    URL.revokeObjectURL(workerUrl)
  }
}

/** Default timeout for worker operations (30 seconds for large files) */
const WORKER_TIMEOUT = 30000

/** Send a message to the worker with timeout support. */
export function sendToWorker(request: WorkerRequest, timeout = WORKER_TIMEOUT): Promise<WorkerResponse> {
  if (!sharedWorker) {
    return Promise.reject(new Error('Worker not initialized'))
  }

  return sendToWorkerInstance(sharedWorker, request, timeout)
}

function sendToWorkerInstance(
  worker: Worker,
  request: WorkerRequest,
  timeout = WORKER_TIMEOUT
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    const timeoutId = setTimeout(() => {
      pendingCallbacks.delete(id)
      reject(new Error(`Worker operation timed out after ${timeout}ms`))
    }, timeout)

    pendingCallbacks.set(id, {
      worker,
      requestType: request.type,
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

    try {
      worker.postMessage({ ...request, _id: id }, transfers)
    } catch (error) {
      pendingCallbacks.delete(id)
      clearTimeout(timeoutId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function rejectWorkerCallbacks(worker: Worker, error: Error): void {
  for (const [id, callback] of pendingCallbacks) {
    if (callback.worker !== worker) continue
    pendingCallbacks.delete(id)
    callback.reject(error)
  }
}
