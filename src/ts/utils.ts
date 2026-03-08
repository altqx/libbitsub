/**
 * Utility functions for libbitsub.
 */

import type {
  AutoSubtitleSource,
  FrameData,
  SubtitleCompositionData,
  SubtitleCueBounds,
  SubtitleData,
  SubtitleFormatName,
  WorkerRendererState
} from './types'
import { isWorkerAvailable } from './worker'

function toBinaryView(binary?: ArrayBuffer | Uint8Array): Uint8Array | null {
  if (binary instanceof Uint8Array) return binary
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary)
  return null
}

function looksLikePgsBinary(binary: Uint8Array): boolean {
  return binary.length >= 2 && binary[0] === 0x50 && binary[1] === 0x47
}

function looksLikeVobSubBinary(binary: Uint8Array): boolean {
  const limit = Math.min(binary.length - 3, 65536)

  for (let index = 0; index <= limit; index++) {
    if (binary[index] !== 0x00 || binary[index + 1] !== 0x00 || binary[index + 2] !== 0x01) {
      continue
    }

    const streamId = binary[index + 3]
    if (streamId === 0xba || streamId === 0xbd || streamId === 0xbe) {
      return true
    }
  }

  return false
}

/** Binary search for timestamp index. */
export function binarySearchTimestamp(timestamps: Float64Array, timeMs: number): number {
  const len = timestamps.length
  if (len === 0) return -1

  let left = 0
  let right = len - 1
  let result = -1

  while (left <= right) {
    const mid = (left + right) >>> 1
    if (timestamps[mid] <= timeMs) {
      result = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return result
}

/** Convert worker frame data to SubtitleData. */
export function convertFrameData(frame: FrameData): SubtitleData {
  const compositionData: SubtitleCompositionData[] = frame.compositions.flatMap((comp) => {
    const clampedData = new Uint8ClampedArray(comp.rgba.length)
    clampedData.set(comp.rgba)
    const trimmed = trimTransparentImageData(clampedData, comp.width, comp.height)

    if (!trimmed) return []

    return {
      pixelData: trimmed.pixelData,
      x: comp.x + trimmed.offsetX,
      y: comp.y + trimmed.offsetY
    }
  })

  return { width: frame.width, height: frame.height, compositionData }
}

export function trimTransparentImageData(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): { pixelData: ImageData; offsetX: number; offsetY: number } | null {
  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
    return null
  }

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] === 0) continue

    const pixelIndex = (index - 3) >> 2
    const y = Math.floor(pixelIndex / width)
    const x = pixelIndex - y * width

    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  if (maxX < minX || maxY < minY) {
    return null
  }

  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
    const untrimmedPixels = new Uint8ClampedArray(pixels.length)
    untrimmedPixels.set(pixels)

    return {
      pixelData: new ImageData(untrimmedPixels, width, height),
      offsetX: 0,
      offsetY: 0
    }
  }

  const trimmedWidth = maxX - minX + 1
  const trimmedHeight = maxY - minY + 1
  const trimmedPixels = new Uint8ClampedArray(trimmedWidth * trimmedHeight * 4)

  for (let y = 0; y < trimmedHeight; y++) {
    const sourceStart = ((minY + y) * width + minX) * 4
    const sourceEnd = sourceStart + trimmedWidth * 4
    trimmedPixels.set(pixels.subarray(sourceStart, sourceEnd), y * trimmedWidth * 4)
  }

  return {
    pixelData: new ImageData(trimmedPixels, trimmedWidth, trimmedHeight),
    offsetX: minX,
    offsetY: minY
  }
}

/** Calculate the bounding box for a subtitle frame. */
export function getSubtitleBounds(data: SubtitleData): SubtitleCueBounds | null {
  if (data.compositionData.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const comp of data.compositionData) {
    minX = Math.min(minX, comp.x)
    minY = Math.min(minY, comp.y)
    maxX = Math.max(maxX, comp.x + comp.pixelData.width)
    maxY = Math.max(maxY, comp.y + comp.pixelData.height)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}

/** Store a frame in the cache and evict older entries when the limit is exceeded. */
export function setCachedFrame(state: WorkerRendererState, index: number, frame: SubtitleData | null): void {
  if (state.frameCache.has(index)) {
    state.frameCache.delete(index)
  }

  state.frameCache.set(index, frame)

  while (state.frameCache.size > state.cacheLimit) {
    const oldestKey = state.frameCache.keys().next().value
    if (oldestKey === undefined) break
    state.frameCache.delete(oldestKey)
  }
}

/** Update the frame cache size limit and immediately trim the cache. */
export function setCacheLimit(state: WorkerRendererState, cacheLimit: number): number {
  state.cacheLimit = Math.max(0, Math.floor(cacheLimit))

  while (state.frameCache.size > state.cacheLimit) {
    const oldestKey = state.frameCache.keys().next().value
    if (oldestKey === undefined) break
    state.frameCache.delete(oldestKey)
  }

  return state.cacheLimit
}

/** Generate a unique worker session ID. */
export function createWorkerSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `libbitsub-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Detect the subtitle format from binary content, filenames or URLs. */
export function detectSubtitleFormat(source: AutoSubtitleSource): SubtitleFormatName | null {
  if (source.idxContent || source.idxUrl) return 'vobsub'

  const fileHint = [source.fileName, source.subUrl].find(Boolean)?.toLowerCase()
  if (fileHint?.endsWith('.sub') || fileHint?.endsWith('.idx')) return 'vobsub'
  if (fileHint?.endsWith('.sup') || fileHint?.endsWith('.pgs')) return 'pgs'

  const binary = toBinaryView(source.data ?? source.subData)
  if (!binary) return null

  if (looksLikePgsBinary(binary)) return 'pgs'
  if (looksLikeVobSubBinary(binary)) return 'vobsub'

  return null
}

/** Create initial worker state. */
export function createWorkerState(): WorkerRendererState {
  return {
    useWorker: isWorkerAvailable(),
    workerReady: false,
    sessionId: null,
    timestamps: new Float64Array(0),
    frameCache: new Map(),
    pendingRenders: new Map(),
    cacheLimit: 24,
    metadata: null
  }
}
