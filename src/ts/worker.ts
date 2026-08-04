/**
 * Web Worker management for libbitsub.
 * Handles off-main-thread subtitle parsing and rendering.
 */

import type { WorkerRequest, WorkerResponse } from './types'
import { getWasmGlueUrl, getWasmUrl } from './wasm'

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
const dvbParsers = new Map();
const vobSubParsers = new Map();
const offscreenSurfaces = new Map();

function buildPgsMetadata(parser) {
    return {
        format: 'pgs',
        cueCount: parser.count,
        screenWidth: parser.screenWidth || 0,
        screenHeight: parser.screenHeight || 0
    };
}

function buildDvbMetadata(parser) {
    return {
        format: 'dvb',
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

function detachOffscreenSurface(sessionId) {
    offscreenSurfaces.delete(sessionId);
}

function disposeSession(sessionId) {
    const pgsParser = pgsParsers.get(sessionId);
    if (pgsParser) {
        pgsParser.free();
        pgsParsers.delete(sessionId);
    }
    const dvbParser = dvbParsers.get(sessionId);
    if (dvbParser) {
        dvbParser.free();
        dvbParsers.delete(sessionId);
    }
    const vobSubParser = vobSubParsers.get(sessionId);
    if (vobSubParser) {
        vobSubParser.free();
        vobSubParsers.delete(sessionId);
    }
    detachOffscreenSurface(sessionId);
}

function getCompositionBounds(compositions) {
    if (!compositions || compositions.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const comp of compositions) {
        minX = Math.min(minX, comp.x);
        minY = Math.min(minY, comp.y);
        maxX = Math.max(maxX, comp.x + comp.width);
        maxY = Math.max(maxY, comp.y + comp.height);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

function computeOffscreenLayout(frame, canvasWidth, canvasHeight, settings) {
    const safeDataWidth = frame.width > 0 ? frame.width : canvasWidth;
    const safeDataHeight = frame.height > 0 ? frame.height : canvasHeight;
    const stretchScaleX = canvasWidth / safeDataWidth;
    const stretchScaleY = canvasHeight / safeDataHeight;
    const bounds = getCompositionBounds(frame.compositions) || {
        x: 0, y: 0, width: safeDataWidth, height: safeDataHeight
    };

    const scale = settings.scale;
    const aspectMode = settings.aspectMode;
    const verticalOffset = settings.verticalOffset;
    const horizontalOffset = settings.horizontalOffset;
    const horizontalAlign = settings.horizontalAlign;
    const bottomPadding = settings.bottomPadding;
    const safeArea = settings.safeArea;
    const opacity = settings.opacity;

    let baseScaleX = stretchScaleX;
    let baseScaleY = stretchScaleY;
    let frameShiftX = 0;
    let frameShiftY = 0;

    if (aspectMode !== 'stretch') {
        const uniformScale = aspectMode === 'cover'
            ? Math.max(stretchScaleX, stretchScaleY)
            : Math.min(stretchScaleX, stretchScaleY);
        baseScaleX = uniformScale;
        baseScaleY = uniformScale;
        frameShiftX = (canvasWidth - safeDataWidth * uniformScale) / 2;
        frameShiftY = (canvasHeight - safeDataHeight * uniformScale) / 2;
    }

    const anchorX = horizontalAlign === 'left'
        ? bounds.x
        : horizontalAlign === 'right'
            ? bounds.x + bounds.width
            : bounds.x + bounds.width / 2;
    const anchorY = bounds.y + bounds.height;

    const scaleX = baseScaleX * scale;
    const scaleY = baseScaleY * scale;
    const anchorShiftX = frameShiftX + anchorX * baseScaleX * (1 - scale);
    const anchorShiftY = frameShiftY + anchorY * baseScaleY * (1 - scale);

    let shiftX = anchorShiftX + (horizontalOffset / 100) * canvasWidth;
    let shiftY = anchorShiftY + (verticalOffset / 100) * canvasHeight;
    shiftY -= (bottomPadding / 100) * canvasHeight;

    const safeX = (safeArea / 100) * canvasWidth;
    const safeY = (safeArea / 100) * canvasHeight;
    const finalMinX = bounds.x * scaleX + shiftX;
    const finalMinY = bounds.y * scaleY + shiftY;
    const finalMaxX = (bounds.x + bounds.width) * scaleX + shiftX;
    const finalMaxY = (bounds.y + bounds.height) * scaleY + shiftY;

    if (finalMinX < safeX) shiftX += safeX - finalMinX;
    if (finalMaxX > canvasWidth - safeX) shiftX -= finalMaxX - (canvasWidth - safeX);
    if (finalMinY < safeY) shiftY += safeY - finalMinY;
    if (finalMaxY > canvasHeight - safeY) shiftY -= finalMaxY - (canvasHeight - safeY);

    return { scaleX, scaleY, shiftX, shiftY, opacity };
}

function presentFrameToOffscreen(surface, frame, canvasWidth, canvasHeight, settings) {
    const ctx = surface.ctx;
    const canvas = surface.canvas;
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!frame || !frame.compositions || frame.compositions.length === 0) {
        return { status: frame ? 'empty' : 'cleared', width: frame?.width || 0, height: frame?.height || 0, compositionCount: 0 };
    }

    const layout = computeOffscreenLayout(frame, canvas.width, canvas.height, settings);
    ctx.save();
    ctx.globalAlpha = layout.opacity;

    for (const comp of frame.compositions) {
        if (!comp.width || !comp.height || !comp.rgba) continue;
        if (surface.buffer.width !== comp.width || surface.buffer.height !== comp.height) {
            surface.buffer.width = comp.width;
            surface.buffer.height = comp.height;
        }
        const pixels = comp.rgba instanceof Uint8ClampedArray
            ? comp.rgba
            : new Uint8ClampedArray(comp.rgba.buffer, comp.rgba.byteOffset, comp.rgba.byteLength);
        surface.bufferCtx.putImageData(new ImageData(pixels, comp.width, comp.height), 0, 0);
        const scaledWidth = comp.width * layout.scaleX;
        const scaledHeight = comp.height * layout.scaleY;
        const adjustedX = comp.x * layout.scaleX + layout.shiftX;
        const adjustedY = comp.y * layout.scaleY + layout.shiftY;
        ctx.drawImage(surface.buffer, adjustedX, adjustedY, scaledWidth, scaledHeight);
    }

    ctx.restore();
    return {
        status: 'rendered',
        width: frame.width,
        height: frame.height,
        compositionCount: frame.compositions.length,
        bounds: getCompositionBounds(frame.compositions)
    };
}

async function initWasm(wasmUrl, glueUrl) {
    if (wasmModule) return;

    let jsGlueUrl = glueUrl;
    if (!jsGlueUrl) {
        const derivedUrl = new URL(wasmUrl);
        derivedUrl.pathname = derivedUrl.pathname.replace(/_bg\.wasm$/, '.js');
        jsGlueUrl = derivedUrl.href;
    }
    const mod = await import(jsGlueUrl);
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
                await initWasm(request.wasmUrl, request.glueUrl);
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
            case 'beginPgs': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.PgsParser();
                parser.reset();
                pgsParsers.set(request.sessionId, parser);
                const timestamps = parser.getTimestamps();
                postResponse(
                    { type: 'pgsProgress', count: 0, added: 0, partial: true, metadata: buildPgsMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'appendPgs': {
                let parser = pgsParsers.get(request.sessionId);
                if (!parser) {
                    parser = new wasmModule.PgsParser();
                    parser.reset();
                    pgsParsers.set(request.sessionId, parser);
                }
                const added = parser.feed(new Uint8Array(request.data));
                const timestamps = parser.getTimestamps();
                postResponse(
                    { type: 'pgsProgress', count: parser.count, added, partial: true, metadata: buildPgsMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'finishPgs': {
                const parser = pgsParsers.get(request.sessionId);
                if (!parser) {
                    postResponse({ type: 'error', message: 'PGS session not found for finishPgs' }, [], _id);
                    break;
                }
                const count = parser.finishFeed();
                const timestamps = parser.getTimestamps();
                postResponse(
                    { type: 'pgsProgress', count, added: 0, partial: false, metadata: buildPgsMetadata(parser), timestamps },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'loadDvb': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.DvbParser();
                const count = parser.parse(new Uint8Array(request.data));
                const timestamps = parser.getTimestamps();
                const endTimestamps = parser.getEndTimestamps();
                dvbParsers.set(request.sessionId, parser);
                postResponse(
                    { type: 'dvbLoaded', count, byteLength: request.data.byteLength, metadata: buildDvbMetadata(parser), timestamps, endTimestamps },
                    [timestamps.buffer, endTimestamps.buffer],
                    _id
                );
                break;
            }
            case 'beginDvb': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.DvbParser();
                parser.reset();
                dvbParsers.set(request.sessionId, parser);
                const timestamps = parser.getTimestamps();
                const endTimestamps = parser.getEndTimestamps();
                postResponse(
                    { type: 'dvbProgress', count: 0, added: 0, partial: true, metadata: buildDvbMetadata(parser), timestamps, endTimestamps },
                    [timestamps.buffer, endTimestamps.buffer],
                    _id
                );
                break;
            }
            case 'appendDvb': {
                let parser = dvbParsers.get(request.sessionId);
                if (!parser) {
                    parser = new wasmModule.DvbParser();
                    parser.reset();
                    dvbParsers.set(request.sessionId, parser);
                }
                const added = parser.feed(new Uint8Array(request.data));
                const timestamps = parser.getTimestamps();
                const endTimestamps = parser.getEndTimestamps();
                postResponse(
                    { type: 'dvbProgress', count: parser.count, added, partial: true, metadata: buildDvbMetadata(parser), timestamps, endTimestamps },
                    [timestamps.buffer, endTimestamps.buffer],
                    _id
                );
                break;
            }
            case 'finishDvb': {
                const parser = dvbParsers.get(request.sessionId);
                if (!parser) {
                    postResponse({ type: 'error', message: 'DVB session not found for finishDvb' }, [], _id);
                    break;
                }
                const count = parser.finishFeed();
                const timestamps = parser.getTimestamps();
                const endTimestamps = parser.getEndTimestamps();
                postResponse(
                    { type: 'dvbProgress', count, added: 0, partial: false, metadata: buildDvbMetadata(parser), timestamps, endTimestamps },
                    [timestamps.buffer, endTimestamps.buffer],
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
            case 'loadVobSubIdx': {
                disposeSession(request.sessionId);
                const parser = new wasmModule.VobSubParser();
                parser.loadFromIdx(request.idxContent);
                const timestamps = parser.getTimestamps();
                vobSubParsers.set(request.sessionId, parser);
                postResponse(
                    {
                        type: 'vobSubProgress',
                        count: parser.count,
                        partial: true,
                        hasSubData: !!parser.hasSubData,
                        metadata: buildVobSubMetadata(parser),
                        timestamps
                    },
                    [timestamps.buffer],
                    _id
                );
                break;
            }
            case 'attachVobSubData': {
                const parser = vobSubParsers.get(request.sessionId);
                if (!parser) {
                    postResponse({ type: 'error', message: 'VobSub session not found for attachVobSubData' }, [], _id);
                    break;
                }
                parser.attachSubData(new Uint8Array(request.subData));
                const timestamps = parser.getTimestamps();
                postResponse(
                    {
                        type: 'vobSubProgress',
                        count: parser.count,
                        partial: false,
                        hasSubData: !!parser.hasSubData,
                        metadata: buildVobSubMetadata(parser),
                        timestamps
                    },
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
            case 'renderDvbAtIndex': {
                const parser = dvbParsers.get(request.sessionId);
                if (!parser) { postResponse({ type: 'dvbFrame', frame: null }, [], _id); break; }
                const frame = parser.renderAtIndex(request.index);
                const renderIssue = parser.lastRenderIssue || '';
                if (!frame) { postResponse({ type: 'dvbFrame', frame: null, renderIssue }, [], _id); break; }
                const frameData = convertFrame(frame, false);
                postResponse({ type: 'dvbFrame', frame: frameData, renderIssue }, frameData.compositions.map((c) => c.rgba.buffer), _id);
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
            case 'findDvbIndex': {
                const parser = dvbParsers.get(request.sessionId);
                postResponse({ type: 'dvbIndex', index: parser ? parser.findIndexAtTimestamp(request.timeMs) : -1 }, [], _id);
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
            case 'getDvbTimestamps': {
                const parser = dvbParsers.get(request.sessionId);
                postResponse({ type: 'dvbTimestamps', timestamps: parser ? parser.getTimestamps() : new Float64Array(0) }, [], _id);
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
            case 'clearDvbCache': {
                dvbParsers.get(request.sessionId)?.clearCache();
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
            case 'disposeDvb': {
                const parser = dvbParsers.get(request.sessionId);
                if (parser) {
                    parser.free();
                    dvbParsers.delete(request.sessionId);
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
            case 'attachOffscreenCanvas': {
                const canvas = request.canvas;
                if (!canvas || typeof canvas.getContext !== 'function') {
                    throw new Error('OffscreenCanvas attach requires a transferable OffscreenCanvas');
                }
                if (offscreenSurfaces.has(request.sessionId)) {
                    throw new Error('OffscreenCanvas already attached for this session');
                }
                const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
                if (!ctx) {
                    throw new Error('OffscreenCanvas 2D context unavailable');
                }
                const buffer = new OffscreenCanvas(1, 1);
                const bufferCtx = buffer.getContext('2d', { alpha: true, desynchronized: true });
                if (!bufferCtx) {
                    throw new Error('OffscreenCanvas buffer 2D context unavailable');
                }
                offscreenSurfaces.set(request.sessionId, { canvas, ctx, buffer, bufferCtx });
                postResponse({ type: 'offscreenAttached' }, [], _id);
                break;
            }
            case 'resizeOffscreenCanvas': {
                const surface = offscreenSurfaces.get(request.sessionId);
                if (surface) {
                    const width = Math.max(1, request.width | 0);
                    const height = Math.max(1, request.height | 0);
                    if (surface.canvas.width !== width) surface.canvas.width = width;
                    if (surface.canvas.height !== height) surface.canvas.height = height;
                }
                postResponse({ type: 'offscreenResized' }, [], _id);
                break;
            }
            case 'detachOffscreenCanvas': {
                detachOffscreenSurface(request.sessionId);
                postResponse({ type: 'offscreenDetached' }, [], _id);
                break;
            }
            case 'clearOffscreenCanvas': {
                const surface = offscreenSurfaces.get(request.sessionId);
                if (surface) {
                    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
                }
                postResponse({ type: 'offscreenCleared' }, [], _id);
                break;
            }
            case 'presentOffscreen': {
                const surface = offscreenSurfaces.get(request.sessionId);
                if (!surface) {
                    postResponse({ type: 'offscreenPresented', status: 'failed', fatal: true, renderIssue: 'OFFSCREEN_SURFACE_MISSING' }, [], _id);
                    break;
                }

                const canvasWidth = Math.max(1, request.canvasWidth | 0);
                const canvasHeight = Math.max(1, request.canvasHeight | 0);
                const settings = request.displaySettings || {
                    scale: 1, aspectMode: 'stretch', verticalOffset: 0, horizontalOffset: 0,
                    horizontalAlign: 'center', bottomPadding: 0, safeArea: 0, opacity: 1
                };

                if (request.index < 0) {
                    if (surface.canvas.width !== canvasWidth) surface.canvas.width = canvasWidth;
                    if (surface.canvas.height !== canvasHeight) surface.canvas.height = canvasHeight;
                    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
                    postResponse({ type: 'offscreenPresented', status: 'cleared', compositionCount: 0 }, [], _id);
                    break;
                }

                let frame = null;
                let renderIssue = '';
                if (request.format === 'pgs') {
                    const parser = pgsParsers.get(request.sessionId);
                    if (!parser) {
                        postResponse({ type: 'offscreenPresented', status: 'failed', fatal: true, renderIssue: 'PARSER_MISSING' }, [], _id);
                        break;
                    }
                    const rendered = parser.renderAtIndex(request.index);
                    renderIssue = parser.lastRenderIssue || '';
                    frame = rendered ? convertFrame(rendered, false) : null;
                } else if (request.format === 'dvb') {
                    const parser = dvbParsers.get(request.sessionId);
                    if (!parser) {
                        postResponse({ type: 'offscreenPresented', status: 'failed', fatal: true, renderIssue: 'PARSER_MISSING' }, [], _id);
                        break;
                    }
                    const rendered = parser.renderAtIndex(request.index);
                    renderIssue = parser.lastRenderIssue || '';
                    frame = rendered ? convertFrame(rendered, false) : null;
                } else {
                    const parser = vobSubParsers.get(request.sessionId);
                    if (!parser) {
                        postResponse({ type: 'offscreenPresented', status: 'failed', fatal: true, renderIssue: 'PARSER_MISSING' }, [], _id);
                        break;
                    }
                    const rendered = parser.renderAtIndex(request.index);
                    renderIssue = parser.lastRenderIssue || '';
                    frame = rendered ? convertFrame(rendered, true) : null;
                }

                if (!frame) {
                    if (surface.canvas.width !== canvasWidth) surface.canvas.width = canvasWidth;
                    if (surface.canvas.height !== canvasHeight) surface.canvas.height = canvasHeight;
                    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
                    postResponse({
                        type: 'offscreenPresented',
                        status: renderIssue ? 'failed' : 'empty',
                        renderIssue,
                        compositionCount: 0
                    }, [], _id);
                    break;
                }

                const presented = presentFrameToOffscreen(surface, frame, canvasWidth, canvasHeight, settings);
                postResponse({
                    type: 'offscreenPresented',
                    status: presented.status,
                    renderIssue,
                    width: presented.width,
                    height: presented.height,
                    compositionCount: presented.compositionCount,
                    bounds: presented.bounds || null
                }, [], _id);
                break;
            }
        }
    } catch (error) {
        postResponse({ type: 'error', message: error instanceof Error ? error.message : String(error) }, [], _id);
    }
};`
}

/** Whether the shared worker has finished WASM initialization. */
export function isWorkerReady(): boolean {
  return sharedWorker !== null
}

/** Create or get the shared worker instance. */
export function getOrCreateWorker(): Promise<Worker> {
  if (sharedWorker) return Promise.resolve(sharedWorker)
  if (workerInitPromise) return workerInitPromise

  const initPromise = initializeWorker()
  workerInitPromise = initPromise
  void initPromise.then(
    () => {
      if (workerInitPromise === initPromise) workerInitPromise = null
    },
    () => {
      if (workerInitPromise === initPromise) workerInitPromise = null
    }
  )

  return initPromise
}

/** Pre-initialize the shared subtitle worker. */
export function warmup(): Promise<void> {
  return ready()
}

/** Wait until the shared worker is ready for parse/render requests. */
export async function ready(): Promise<void> {
  if (!isWorkerAvailable()) return
  if (sharedWorker) return
  await getOrCreateWorker()
}

async function initializeWorker(): Promise<Worker> {
  const blob = new Blob([createWorkerScript()], { type: 'application/javascript' })
  const workerUrl = URL.createObjectURL(blob)
  let worker: Worker
  try {
    worker = new Worker(workerUrl, { type: 'module' })
  } catch (error) {
    URL.revokeObjectURL(workerUrl)
    throw error instanceof Error ? error : new Error(String(error))
  }

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
    try {
      worker.terminate()
    } catch {
      /* ignore */
    }
  }

  try {
    const initResponse = await sendToWorkerInstance(worker, {
      type: 'init',
      wasmUrl: getWasmUrl(),
      glueUrl: getWasmGlueUrl()
    })
    if (initResponse.type === 'error') {
      throw new Error(initResponse.message)
    }
    if (initResponse.type !== 'initComplete' || !initResponse.success) {
      throw new Error('Worker WASM initialization failed')
    }
    sharedWorker = worker
    return worker
  } catch (error) {
    const workerError = error instanceof Error ? error : new Error(String(error))
    rejectWorkerCallbacks(worker, workerError)
    if (sharedWorker === worker) sharedWorker = null
    try {
      worker.terminate()
    } catch {
      /* ignore */
    }
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
    if ('canvas' in request && request.canvas) transfers.push(request.canvas)

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

/**
 * Test-only helper: tear down shared worker state between Bun test files.
 * Not part of the public runtime API.
 */
export function resetWorkerForTests(): void {
  if (sharedWorker) {
    try {
      sharedWorker.terminate()
    } catch {
      /* ignore */
    }
  }
  sharedWorker = null
  workerInitPromise = null
  for (const [, callback] of pendingCallbacks) {
    callback.reject(new Error('Worker reset for tests'))
  }
  pendingCallbacks.clear()
}
