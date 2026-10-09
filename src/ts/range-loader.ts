import type { AssetFetchStrategy } from './types'

export type { AssetFetchStrategy }

/** Progress event emitted while fetching an asset. */
export interface AssetFetchProgress {
  loaded: number
  total: number | null
  ratio: number | null
  rangeSupported: boolean
  strategy: AssetFetchStrategy
}

/** Options for fetchSubtitleAsset(). */
export interface AssetFetchOptions {
  signal?: AbortSignal
  onProgress?: (progress: AssetFetchProgress) => void
  rangeChunkThreshold?: number
  rangeChunkSize?: number
  preferRange?: boolean
  headers?: HeadersInit
  /** Maximum asset size in bytes (default 256 MiB). Larger responses are rejected. */
  maxBytes?: number
}

/** Result of probing HTTP range support. */
export interface RangeProbeResult {
  supportsRange: boolean
  size: number | null
  acceptRanges: string | null
}

const DEFAULT_RANGE_CHUNK_THRESHOLD = 2 * 1024 * 1024
const DEFAULT_RANGE_CHUNK_SIZE = 512 * 1024
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

function resolveMaxBytes(options: AssetFetchOptions): number {
  const value = options.maxBytes
  return value !== undefined && value >= 0 ? Math.floor(value) : DEFAULT_MAX_BYTES
}

function assetTooLarge(size: number, maxBytes: number): Error {
  return new Error(`Subtitle asset exceeds the ${maxBytes} byte limit (${size} bytes)`)
}

/** Growable byte buffer that refuses to exceed a fixed limit. */
class BoundedBuffer {
  private buffer: Uint8Array
  length = 0

  constructor(
    private readonly maxBytes: number,
    sizeHint: number | null
  ) {
    const initial = sizeHint != null && sizeHint <= maxBytes ? sizeHint : Math.min(maxBytes, 64 * 1024)
    this.buffer = new Uint8Array(initial)
  }

  append(chunk: Uint8Array): void {
    const needed = this.length + chunk.byteLength
    if (needed > this.maxBytes) throw assetTooLarge(needed, this.maxBytes)
    if (needed > this.buffer.byteLength) {
      const grown = new Uint8Array(Math.min(this.maxBytes, Math.max(needed, this.buffer.byteLength * 2)))
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(chunk, this.length)
    this.length = needed
  }

  toUint8Array(): Uint8Array {
    return this.length === this.buffer.byteLength ? this.buffer : this.buffer.slice(0, this.length)
  }
}

function emitProgress(
  onProgress: AssetFetchOptions['onProgress'],
  loaded: number,
  total: number | null,
  rangeSupported: boolean,
  strategy: AssetFetchStrategy
): void {
  if (!onProgress) return
  onProgress({
    loaded,
    total,
    ratio: total && total > 0 ? Math.min(1, loaded / total) : null,
    rangeSupported,
    strategy
  })
}

function parseContentLength(header: string | null): number | null {
  if (!header) return null
  const value = Number(header)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null
  const match = /bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)/i.exec(header)
  if (!match) return null
  if (match[1] === '*') return null
  return parseContentLength(match[1])
}

function mergeHeaders(base?: HeadersInit, extra?: HeadersInit): Headers {
  const headers = new Headers(base)
  if (extra) {
    const more = new Headers(extra)
    more.forEach((value, key) => headers.set(key, value))
  }
  return headers
}

/** Probe whether a URL accepts HTTP range requests. */
export async function probeRangeSupport(url: string, options: AssetFetchOptions = {}): Promise<RangeProbeResult> {
  const headers = mergeHeaders(options.headers, { Range: 'bytes=0-0' })

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: options.signal
    })

    if (response.status === 206) {
      const size =
        parseContentRangeTotal(response.headers.get('content-range')) ??
        parseContentLength(response.headers.get('content-length'))
      try {
        await response.body?.cancel()
      } catch {
        /* ignore */
      }
      return {
        supportsRange: true,
        size,
        acceptRanges: response.headers.get('accept-ranges')
      }
    }

    if (response.ok) {
      const accept = response.headers.get('accept-ranges')
      const size = parseContentLength(response.headers.get('content-length'))
      try {
        await response.body?.cancel()
      } catch {
        /* ignore */
      }
      return {
        supportsRange: Boolean(accept && accept.toLowerCase() !== 'none'),
        size,
        acceptRanges: accept
      }
    }
  } catch {
    /* try HEAD */
  }

  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: mergeHeaders(options.headers),
      signal: options.signal
    })
    if (!head.ok) {
      return { supportsRange: false, size: null, acceptRanges: null }
    }
    const accept = head.headers.get('accept-ranges')
    return {
      supportsRange: Boolean(accept && accept.toLowerCase() !== 'none'),
      size: parseContentLength(head.headers.get('content-length')),
      acceptRanges: accept
    }
  } catch {
    return { supportsRange: false, size: null, acceptRanges: null }
  }
}

/** Read a range response body, keeping at most `limit` bytes. */
async function readRangeBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer())
    return buffer.byteLength > limit ? buffer.subarray(0, limit) : buffer
  }

  const reader = response.body.getReader()
  const output = new Uint8Array(limit)
  let loaded = 0
  while (loaded < limit) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const take = Math.min(value.byteLength, limit - loaded)
    output.set(value.subarray(0, take), loaded)
    loaded += take
  }
  if (loaded >= limit) {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
  return loaded === limit ? output : output.subarray(0, loaded)
}

async function readResponseStream(
  response: Response,
  totalHint: number | null,
  rangeSupported: boolean,
  strategy: AssetFetchStrategy,
  maxBytes: number,
  onProgress?: AssetFetchOptions['onProgress'],
  onChunk?: (chunk: Uint8Array, progress: AssetFetchProgress) => void | Promise<void>
): Promise<Uint8Array> {
  const total = totalHint ?? parseContentLength(response.headers.get('content-length'))
  if (total != null && total > maxBytes) {
    try {
      await response.body?.cancel()
    } catch {
      /* ignore */
    }
    throw assetTooLarge(total, maxBytes)
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw assetTooLarge(buffer.byteLength, maxBytes)
    const progress: AssetFetchProgress = {
      loaded: buffer.byteLength,
      total: total ?? buffer.byteLength,
      ratio: 1,
      rangeSupported,
      strategy: strategy === 'stream' ? 'basic' : strategy
    }
    await onChunk?.(buffer, progress)
    onProgress?.(progress)
    return buffer
  }

  const reader = response.body.getReader()
  const assembled = new BoundedBuffer(maxBytes, total)
  let loaded = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue

    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
    try {
      assembled.append(chunk)
    } catch (error) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      throw error
    }
    loaded += chunk.byteLength

    const progress: AssetFetchProgress = {
      loaded,
      total,
      ratio: total && total > 0 ? Math.min(1, loaded / total) : null,
      rangeSupported,
      strategy
    }
    await onChunk?.(chunk, progress)
    onProgress?.(progress)
  }

  const data = assembled.toUint8Array()
  emitProgress(onProgress, data.byteLength, total ?? data.byteLength, rangeSupported, strategy)
  return data
}

async function fetchByRangeChunks(
  url: string,
  size: number,
  options: AssetFetchOptions,
  onChunk?: (chunk: Uint8Array, progress: AssetFetchProgress) => void | Promise<void>
): Promise<Uint8Array> {
  const chunkSize = Math.max(1, Math.floor(options.rangeChunkSize ?? DEFAULT_RANGE_CHUNK_SIZE))
  const maxBytes = resolveMaxBytes(options)
  if (size > maxBytes) throw assetTooLarge(size, maxBytes)
  const assembled = new Uint8Array(size)
  let loaded = 0

  for (let start = 0; start < size; start += chunkSize) {
    const end = Math.min(size - 1, start + chunkSize - 1)
    const response = await fetch(url, {
      method: 'GET',
      headers: mergeHeaders(options.headers, { Range: `bytes=${start}-${end}` }),
      signal: options.signal
    })

    if (response.status !== 206 && !(response.ok && start === 0 && end >= size - 1)) {
      throw new Error(`Failed to fetch subtitle range ${start}-${end}: ${response.status}`)
    }

    // Never buffer more than the requested range, whatever the server sends.
    const buffer = await readRangeBody(response, end - start + 1)
    if (buffer.byteLength === 0) {
      throw new Error(`Empty subtitle range response for bytes=${start}-${end}`)
    }

    assembled.set(buffer, start)
    loaded = start + buffer.byteLength

    const slice = assembled.subarray(start, loaded)
    const progress: AssetFetchProgress = {
      loaded,
      total: size,
      ratio: size > 0 ? Math.min(1, loaded / size) : null,
      rangeSupported: true,
      strategy: 'range-chunks'
    }
    await onChunk?.(slice, progress)
    options.onProgress?.(progress)
  }

  return assembled
}

/** Fetch a subtitle asset with optional range/stream strategies. */
export async function fetchSubtitleAsset(
  url: string,
  options: AssetFetchOptions = {},
  onChunk?: (chunk: Uint8Array, progress: AssetFetchProgress) => void | Promise<void>
): Promise<{ data: Uint8Array; strategy: AssetFetchStrategy; rangeSupported: boolean; total: number | null }> {
  const preferRange = options.preferRange !== false
  const threshold = options.rangeChunkThreshold ?? DEFAULT_RANGE_CHUNK_THRESHOLD

  let rangeSupported = false
  let knownSize: number | null = null

  if (preferRange) {
    const probe = await probeRangeSupport(url, options)
    rangeSupported = probe.supportsRange
    knownSize = probe.size

    if (rangeSupported && knownSize != null && knownSize >= threshold) {
      const data = await fetchByRangeChunks(url, knownSize, options, onChunk)
      return { data, strategy: 'range-chunks', rangeSupported: true, total: knownSize }
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: mergeHeaders(options.headers),
    signal: options.signal
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch subtitle: ${response.status}`)
  }

  const total = knownSize ?? parseContentLength(response.headers.get('content-length'))
  const strategy: AssetFetchStrategy = response.body ? 'stream' : 'basic'
  const data = await readResponseStream(
    response,
    total,
    rangeSupported,
    strategy,
    resolveMaxBytes(options),
    options.onProgress,
    onChunk
  )
  return { data, strategy, rangeSupported, total: total ?? data.byteLength }
}

/** Fetch a subtitle asset and decode it as text. */
export async function fetchSubtitleText(url: string, options: AssetFetchOptions = {}): Promise<string> {
  const { data } = await fetchSubtitleAsset(url, {
    ...options,
    rangeChunkThreshold: Number.POSITIVE_INFINITY,
    preferRange: false
  })
  return new TextDecoder('utf-8').decode(data)
}
