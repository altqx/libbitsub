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

const EBML_HEADER_ID = 0x1a45dfa3
const EBML_DOC_TYPE_ID = 0x4282
const EBML_SEGMENT_ID = 0x18538067
const EBML_TRACKS_ID = 0x1654ae6b
const EBML_TRACK_ENTRY_ID = 0xae
const EBML_TRACK_TYPE_ID = 0x83
const EBML_CODEC_ID = 0x86
const MATROSKA_SUBTITLE_TRACK_TYPE = 0x11
const MATROSKA_VOBSUB_CODEC_ID = 'S_VOBSUB'
const MAX_MKS_PROBE_BYTES = 1 << 20

interface EbmlVint {
  value: number
  length: number
  isUnknownSize: boolean
}

function readEbmlVint(binary: Uint8Array, offset: number, keepMarker: boolean): EbmlVint | null {
  if (offset >= binary.length) return null

  const firstByte = binary[offset]
  if (firstByte === 0) return null

  let mask = 0x80
  let length = 1

  while ((firstByte & mask) === 0) {
    mask >>= 1
    length += 1
    if (mask === 0 || length > 8) return null
  }

  if (offset + length > binary.length) return null

  let isUnknownSize = !keepMarker
  let value = keepMarker ? firstByte : firstByte & (mask - 1)
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + binary[offset + index]
    if (!keepMarker && binary[offset + index] !== 0xff) {
      isUnknownSize = false
    }
  }

  if (!keepMarker && (firstByte & (mask - 1)) !== mask - 1) {
    isUnknownSize = false
  }

  return { value, length, isUnknownSize }
}

function readEbmlElementBounds(binary: Uint8Array, offset: number, limit: number): { id: number; dataStart: number; dataEnd: number } | null {
  const id = readEbmlVint(binary, offset, true)
  if (!id) return null

  const size = readEbmlVint(binary, offset + id.length, false)
  if (!size) return null

  const dataStart = offset + id.length + size.length
  if (dataStart > limit) return null

  const dataEnd = size.isUnknownSize ? limit : Math.min(dataStart + size.value, limit)

  return { id: id.value, dataStart, dataEnd }
}

function readMatroskaDocType(binary: Uint8Array, limit: number): string | null {
  const header = readEbmlElementBounds(binary, 0, limit)
  if (!header || header.id !== EBML_HEADER_ID) return null

  let offset = header.dataStart
  while (offset < header.dataEnd) {
    const element = readEbmlElementBounds(binary, offset, header.dataEnd)
    if (!element) return null

    if (element.id === EBML_DOC_TYPE_ID) {
      return new TextDecoder('ascii').decode(binary.subarray(element.dataStart, element.dataEnd)).toLowerCase()
    }

    offset = element.dataEnd
  }

  return null
}

function readAscii(binary: Uint8Array, start: number, end: number): string {
  return new TextDecoder('ascii').decode(binary.subarray(start, end))
}

function hasVobSubTrack(binary: Uint8Array, headerEnd: number, limit: number): boolean {
  let offset = headerEnd

  while (offset < limit) {
    const element = readEbmlElementBounds(binary, offset, limit)
    if (!element) return false

    if (element.id === EBML_SEGMENT_ID) {
      return segmentHasVobSubTrack(binary, element.dataStart, element.dataEnd)
    }

    offset = element.dataEnd
  }

  return false
}

function segmentHasVobSubTrack(binary: Uint8Array, start: number, end: number): boolean {
  let offset = start

  while (offset < end) {
    const element = readEbmlElementBounds(binary, offset, end)
    if (!element) return false

    if (element.id === EBML_TRACKS_ID) {
      return tracksContainVobSubTrack(binary, element.dataStart, element.dataEnd)
    }

    offset = element.dataEnd
  }

  return false
}

function tracksContainVobSubTrack(binary: Uint8Array, start: number, end: number): boolean {
  let offset = start

  while (offset < end) {
    const element = readEbmlElementBounds(binary, offset, end)
    if (!element) return false

    if (element.id === EBML_TRACK_ENTRY_ID && trackEntryIsVobSub(binary, element.dataStart, element.dataEnd)) {
      return true
    }

    offset = element.dataEnd
  }

  return false
}

function trackEntryIsVobSub(binary: Uint8Array, start: number, end: number): boolean {
  let offset = start
  let trackType: number | null = null
  let codecId: string | null = null

  while (offset < end) {
    const element = readEbmlElementBounds(binary, offset, end)
    if (!element) return false

    if (element.id === EBML_TRACK_TYPE_ID) {
      trackType = 0
      for (let index = element.dataStart; index < element.dataEnd; index += 1) {
        trackType = trackType * 256 + binary[index]
      }
    } else if (element.id === EBML_CODEC_ID) {
      codecId = readAscii(binary, element.dataStart, element.dataEnd)
    }

    offset = element.dataEnd
  }

  return trackType === MATROSKA_SUBTITLE_TRACK_TYPE && codecId === MATROSKA_VOBSUB_CODEC_ID
}

function looksLikeMksBinary(binary: Uint8Array): boolean {
  const probeLength = Math.min(binary.length, MAX_MKS_PROBE_BYTES)
  if (probeLength < 4) return false

  const docType = readMatroskaDocType(binary, probeLength)
  if (docType !== 'matroska') return false

  const header = readEbmlElementBounds(binary, 0, probeLength)
  if (!header || header.id !== EBML_HEADER_ID) return false

  return hasVobSubTrack(binary, header.dataEnd, probeLength)
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

export function isMksSource(source: Pick<AutoSubtitleSource, 'data' | 'subData' | 'fileName' | 'subUrl'>): boolean {
  const fileHint = [source.fileName, source.subUrl].find(Boolean)?.toLowerCase()
  if (fileHint?.endsWith('.mks')) return true

  const binary = toBinaryView(source.data ?? source.subData)
  return binary ? looksLikeMksBinary(binary) : false
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
  if (fileHint?.endsWith('.mks')) return 'vobsub'
  if (fileHint?.endsWith('.sup') || fileHint?.endsWith('.pgs')) return 'pgs'

  const binary = toBinaryView(source.data ?? source.subData)
  if (!binary) return null

  if (looksLikePgsBinary(binary)) return 'pgs'
  if (looksLikeMksBinary(binary)) return 'vobsub'
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
