/**
 * Low-level subtitle parsers for libbitsub.
 * Use these for programmatic access to subtitle data without video integration.
 */

import type {
  AutoSubtitleSource,
  SubtitleData,
  SubtitleCueMetadata,
  SubtitleCompositionData,
  SubtitleParserMetadata,
  SubtitleFrame,
  SubtitleFormatName,
  VobSubFrame,
  RenderResult,
  WasmPgsParser,
  WasmVobSubParser,
  WasmSubtitleRenderer
} from './types'
import { getWasm } from './wasm'
import { detectSubtitleFormat, getSubtitleBounds, trimTransparentImageData } from './utils'

/**
 * Low-level PGS subtitle parser using WASM.
 * Use this for programmatic access to PGS data without video integration.
 */
export class PgsParser {
  private parser: WasmPgsParser | null = null
  private timestamps: Float64Array = new Float64Array(0)
  private cueMetadataCache = new Map<number, SubtitleCueMetadata | null>()

  constructor() {
    const wasm = getWasm()
    this.parser = new wasm.PgsParser()
  }

  /**
   * Load PGS subtitle data from a Uint8Array.
   */
  load(data: Uint8Array): number {
    if (!this.parser) throw new Error('Parser not initialized')
    const count = this.parser.parse(data)
    this.timestamps = this.parser.getTimestamps()
    this.cueMetadataCache.clear()
    return count
  }

  /**
   * Get all timestamps in milliseconds.
   */
  getTimestamps(): Float64Array {
    return this.timestamps
  }

  /**
   * Get the number of display sets.
   */
  get count(): number {
    return this.parser?.count ?? 0
  }

  /**
   * Find the display set index for a given timestamp in seconds.
   */
  findIndexAtTimestamp(timeSeconds: number): number {
    if (!this.parser) return -1
    return this.parser.findIndexAtTimestamp(timeSeconds * 1000)
  }

  /**
   * Render subtitle at the given index.
   */
  renderAtIndex(index: number): SubtitleData | undefined {
    if (!this.parser) return undefined

    const frame = this.parser.renderAtIndex(index)
    if (!frame) return undefined

    return this.convertFrame(frame)
  }

  /** Get parser-level metadata. */
  getMetadata(): SubtitleParserMetadata {
    return {
      format: 'pgs',
      cueCount: this.count,
      screenWidth: this.parser?.screenWidth ?? 0,
      screenHeight: this.parser?.screenHeight ?? 0
    }
  }

  /** Get cue metadata for the given index. */
  getCueMetadata(index: number): SubtitleCueMetadata | null {
    if (!this.parser || index < 0 || index >= this.count) return null
    if (this.cueMetadataCache.has(index)) return this.cueMetadataCache.get(index) ?? null

    const startTime = this.parser.getCueStartTime(index)
    const endTime = this.parser.getCueEndTime(index)
    const frame = this.renderAtIndex(index)

    const cueMetadata: SubtitleCueMetadata = {
      index,
      format: 'pgs',
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      screenWidth: this.parser.screenWidth,
      screenHeight: this.parser.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : null,
      compositionCount: this.parser.getCueCompositionCount(index),
      paletteId: this.parser.getCuePaletteId(index),
      compositionState: this.parser.getCueCompositionState(index)
    }

    this.cueMetadataCache.set(index, cueMetadata)
    return cueMetadata
  }

  /**
   * Render subtitle at the given timestamp in seconds.
   */
  renderAtTimestamp(timeSeconds: number): SubtitleData | undefined {
    const index = this.findIndexAtTimestamp(timeSeconds)
    if (index < 0) return undefined
    return this.renderAtIndex(index)
  }

  /**
   * Convert WASM frame to SubtitleData.
   */
  private convertFrame(frame: SubtitleFrame): SubtitleData {
    const compositionData: SubtitleCompositionData[] = []

    for (let i = 0; i < frame.compositionCount; i++) {
      const comp = frame.getComposition(i)
      if (!comp) continue

      const rgba = comp.getRgba()
      const expectedLength = comp.width * comp.height * 4

      // Validate buffer size
      if (rgba.length !== expectedLength || comp.width === 0 || comp.height === 0) {
        console.warn(
          `Invalid composition data: expected ${expectedLength} bytes, got ${rgba.length}, size=${comp.width}x${comp.height}`
        )
        continue
      }

      // Copy to new Uint8ClampedArray to ensure proper buffer ownership
      const clampedData = new Uint8ClampedArray(rgba.length)
      clampedData.set(rgba)

      const trimmed = trimTransparentImageData(clampedData, comp.width, comp.height)

      if (!trimmed) {
        continue
      }

      compositionData.push({
        pixelData: trimmed.pixelData,
        x: comp.x + trimmed.offsetX,
        y: comp.y + trimmed.offsetY
      })
    }

    return {
      width: frame.width,
      height: frame.height,
      compositionData
    }
  }

  /**
   * Clear internal caches.
   */
  clearCache(): void {
    this.parser?.clearCache()
    this.cueMetadataCache.clear()
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.parser?.free()
    this.parser = null
    this.timestamps = new Float64Array(0)
    this.cueMetadataCache.clear()
  }
}

/**
 * Low-level VobSub subtitle parser using WASM.
 * Use this for programmatic access to VobSub data without video integration.
 */
export class VobSubParserLowLevel {
  private parser: WasmVobSubParser | null = null
  private timestamps: Float64Array = new Float64Array(0)
  private cueMetadataCache = new Map<number, SubtitleCueMetadata | null>()

  constructor() {
    const wasm = getWasm()
    this.parser = new wasm.VobSubParser()
  }

  /**
   * Load VobSub from IDX and SUB data.
   */
  loadFromData(idxContent: string, subData: Uint8Array): void {
    if (!this.parser) throw new Error('Parser not initialized')
    this.parser.loadFromData(idxContent, subData)
    this.timestamps = this.parser.getTimestamps()
    this.cueMetadataCache.clear()
  }

  /**
   * Load VobSub from SUB file only.
   */
  loadFromSubOnly(subData: Uint8Array): void {
    if (!this.parser) throw new Error('Parser not initialized')
    this.parser.loadFromSubOnly(subData)
    this.timestamps = this.parser.getTimestamps()
    this.cueMetadataCache.clear()
  }

  /**
   * Get all timestamps in milliseconds.
   */
  getTimestamps(): Float64Array {
    return this.timestamps
  }

  /**
   * Get the number of subtitle entries.
   */
  get count(): number {
    return this.parser?.count ?? 0
  }

  /**
   * Find the subtitle index for a given timestamp in seconds.
   */
  findIndexAtTimestamp(timeSeconds: number): number {
    if (!this.parser) return -1
    return this.parser.findIndexAtTimestamp(timeSeconds * 1000)
  }

  /**
   * Render subtitle at the given index.
   */
  renderAtIndex(index: number): SubtitleData | undefined {
    if (!this.parser) return undefined

    const frame = this.parser.renderAtIndex(index)
    if (!frame) return undefined

    return this.convertFrame(frame)
  }

  /** Get parser-level metadata. */
  getMetadata(): SubtitleParserMetadata {
    return {
      format: 'vobsub',
      cueCount: this.count,
      screenWidth: this.parser?.screenWidth ?? 0,
      screenHeight: this.parser?.screenHeight ?? 0,
      language: this.parser?.language || null,
      trackId: this.parser?.trackId || null,
      hasIdxMetadata: this.parser?.hasIdxMetadata ?? false
    }
  }

  /** Get cue metadata for the given index. */
  getCueMetadata(index: number): SubtitleCueMetadata | null {
    if (!this.parser || index < 0 || index >= this.count) return null
    if (this.cueMetadataCache.has(index)) return this.cueMetadataCache.get(index) ?? null

    const startTime = this.parser.getCueStartTime(index)
    const endTime = this.parser.getCueEndTime(index)
    const frame = this.renderAtIndex(index)

    const cueMetadata: SubtitleCueMetadata = {
      index,
      format: 'vobsub',
      startTime,
      endTime,
      duration: this.parser.getCueDuration(index),
      screenWidth: this.parser.screenWidth,
      screenHeight: this.parser.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : null,
      compositionCount: frame?.compositionData.length ?? 0,
      language: this.parser.language || null,
      trackId: this.parser.trackId || null,
      filePosition: this.parser.getCueFilePosition(index)
    }

    this.cueMetadataCache.set(index, cueMetadata)
    return cueMetadata
  }

  /**
   * Render subtitle at the given timestamp in seconds.
   */
  renderAtTimestamp(timeSeconds: number): SubtitleData | undefined {
    const index = this.findIndexAtTimestamp(timeSeconds)
    if (index < 0) return undefined
    return this.renderAtIndex(index)
  }

  /**
   * Convert WASM frame to SubtitleData.
   */
  private convertFrame(frame: VobSubFrame): SubtitleData {
    const rgba = frame.getRgba()
    const expectedLength = frame.width * frame.height * 4

    // Validate buffer size
    if (rgba.length !== expectedLength || frame.width === 0 || frame.height === 0) {
      console.warn(
        `Invalid VobSub frame: expected ${expectedLength} bytes, got ${rgba.length}, size=${frame.width}x${frame.height}`
      )
      return {
        width: frame.screenWidth,
        height: frame.screenHeight,
        compositionData: []
      }
    }

    // Copy to new Uint8ClampedArray to ensure proper buffer ownership
    const clampedData = new Uint8ClampedArray(rgba.length)
    clampedData.set(rgba)

    const trimmed = trimTransparentImageData(clampedData, frame.width, frame.height)

    if (!trimmed) {
      return {
        width: frame.screenWidth,
        height: frame.screenHeight,
        compositionData: []
      }
    }

    return {
      width: frame.screenWidth,
      height: frame.screenHeight,
      compositionData: [
        {
          pixelData: trimmed.pixelData,
          x: frame.x + trimmed.offsetX,
          y: frame.y + trimmed.offsetY
        }
      ]
    }
  }

  /**
   * Clear internal caches.
   */
  clearCache(): void {
    this.parser?.clearCache()
    this.cueMetadataCache.clear()
  }

  /**
   * Enable or disable debanding filter.
   */
  setDebandEnabled(enabled: boolean): void {
    this.parser?.setDebandEnabled(enabled)
  }

  /**
   * Set debanding threshold (0-255, default: 64).
   */
  setDebandThreshold(threshold: number): void {
    this.parser?.setDebandThreshold(threshold)
  }

  /**
   * Set debanding sample range in pixels (1-64, default: 15).
   */
  setDebandRange(range: number): void {
    this.parser?.setDebandRange(range)
  }

  /**
   * Check if debanding is enabled.
   */
  get debandEnabled(): boolean {
    return this.parser?.debandEnabled ?? true
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.parser?.free()
    this.parser = null
    this.timestamps = new Float64Array(0)
    this.cueMetadataCache.clear()
  }
}

/**
 * Unified subtitle parser that handles both PGS and VobSub formats.
 */
export class UnifiedSubtitleParser {
  private renderer: WasmSubtitleRenderer | null = null
  private timestamps: Float64Array = new Float64Array(0)
  private cueMetadataCache = new Map<number, SubtitleCueMetadata | null>()

  constructor() {
    const wasm = getWasm()
    this.renderer = new wasm.SubtitleRenderer()
  }

  /**
   * Load PGS subtitle data.
   */
  loadPgs(data: Uint8Array): number {
    if (!this.renderer) throw new Error('Renderer not initialized')
    const count = this.renderer.loadPgs(data)
    this.timestamps = this.renderer.getTimestamps()
    this.cueMetadataCache.clear()
    return count
  }

  /**
   * Load VobSub from IDX and SUB data.
   */
  loadVobSub(idxContent: string, subData: Uint8Array): void {
    if (!this.renderer) throw new Error('Renderer not initialized')
    this.renderer.loadVobSub(idxContent, subData)
    this.timestamps = this.renderer.getTimestamps()
    this.cueMetadataCache.clear()
  }

  /**
   * Load VobSub from SUB file only.
   */
  loadVobSubOnly(subData: Uint8Array): void {
    if (!this.renderer) throw new Error('Renderer not initialized')
    this.renderer.loadVobSubOnly(subData)
    this.timestamps = this.renderer.getTimestamps()
    this.cueMetadataCache.clear()
  }

  /** Load subtitle data with automatic format detection. */
  loadAuto(source: AutoSubtitleSource): SubtitleFormatName {
    const format = detectSubtitleFormat(source)
    if (!format) {
      throw new Error('Unable to detect subtitle format')
    }

    if (format === 'pgs') {
      const data = source.data ?? source.subData
      if (!data) throw new Error('No binary subtitle data provided for PGS')
      this.loadPgs(data instanceof Uint8Array ? data : new Uint8Array(data))
      return 'pgs'
    }

    const subBinary = source.subData ?? source.data
    if (!subBinary) throw new Error('No SUB binary data provided for VobSub')

    if (source.idxContent) {
      this.loadVobSub(source.idxContent, subBinary instanceof Uint8Array ? subBinary : new Uint8Array(subBinary))
    } else {
      this.loadVobSubOnly(subBinary instanceof Uint8Array ? subBinary : new Uint8Array(subBinary))
    }

    return 'vobsub'
  }

  /**
   * Get the current subtitle format.
   */
  get format(): 'pgs' | 'vobsub' | null {
    const fmt = this.renderer?.format
    if (fmt === 0) return 'pgs'
    if (fmt === 1) return 'vobsub'
    return null
  }

  /**
   * Get all timestamps in milliseconds.
   */
  getTimestamps(): Float64Array {
    return this.timestamps
  }

  /**
   * Get the number of subtitle entries.
   */
  get count(): number {
    return this.renderer?.count ?? 0
  }

  /**
   * Find the subtitle index for a given timestamp in seconds.
   */
  findIndexAtTimestamp(timeSeconds: number): number {
    if (!this.renderer) return -1
    return this.renderer.findIndexAtTimestamp(timeSeconds * 1000)
  }

  /**
   * Render subtitle at the given index.
   */
  renderAtIndex(index: number): SubtitleData | undefined {
    if (!this.renderer) return undefined

    const result = this.renderer.renderAtIndex(index)
    if (!result) return undefined

    return this.convertResult(result)
  }

  /** Get parser-level metadata. */
  getMetadata(): SubtitleParserMetadata | null {
    if (!this.renderer || !this.format) return null

    return {
      format: this.format,
      cueCount: this.count,
      screenWidth: this.renderer.screenWidth,
      screenHeight: this.renderer.screenHeight,
      language: this.format === 'vobsub' ? this.renderer.language || null : null,
      trackId: this.format === 'vobsub' ? this.renderer.trackId || null : null,
      hasIdxMetadata: this.format === 'vobsub' ? this.renderer.hasIdxMetadata : undefined
    }
  }

  /** Get cue metadata for the given index. */
  getCueMetadata(index: number): SubtitleCueMetadata | null {
    if (!this.renderer || !this.format || index < 0 || index >= this.count) return null
    if (this.cueMetadataCache.has(index)) return this.cueMetadataCache.get(index) ?? null

    const startTime = this.renderer.getCueStartTime(index)
    const endTime = this.renderer.getCueEndTime(index)
    const frame = this.renderAtIndex(index)

    const cueMetadata: SubtitleCueMetadata = {
      index,
      format: this.format,
      startTime,
      endTime,
      duration: this.renderer.getCueDuration(index),
      screenWidth: this.renderer.screenWidth,
      screenHeight: this.renderer.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : null,
      compositionCount: frame?.compositionData.length ?? 0,
      language: this.format === 'vobsub' ? this.renderer.language || null : null,
      trackId: this.format === 'vobsub' ? this.renderer.trackId || null : null
    }

    this.cueMetadataCache.set(index, cueMetadata)
    return cueMetadata
  }

  /**
   * Render subtitle at the given timestamp in seconds.
   */
  renderAtTimestamp(timeSeconds: number): SubtitleData | undefined {
    if (!this.renderer) return undefined

    const result = this.renderer.renderAtTimestamp(timeSeconds)
    if (!result) return undefined

    return this.convertResult(result)
  }

  /**
   * Convert WASM result to SubtitleData.
   */
  private convertResult(result: RenderResult): SubtitleData {
    const compositionData: SubtitleCompositionData[] = []

    for (let i = 0; i < result.compositionCount; i++) {
      const rgba = result.getCompositionRgba(i)
      const width = result.getCompositionWidth(i)
      const height = result.getCompositionHeight(i)
      const expectedLength = width * height * 4

      if (width > 0 && height > 0 && rgba.length === expectedLength) {
        const clampedData = new Uint8ClampedArray(rgba.length)
        clampedData.set(rgba)

        const trimmed = trimTransparentImageData(clampedData, width, height)

        if (!trimmed) {
          continue
        }

        compositionData.push({
          pixelData: trimmed.pixelData,
          x: result.getCompositionX(i) + trimmed.offsetX,
          y: result.getCompositionY(i) + trimmed.offsetY
        })
      } else if (width > 0 && height > 0) {
        console.warn(
          `Invalid unified result: expected ${expectedLength} bytes, got ${rgba.length}, size=${width}x${height}`
        )
      }
    }

    return {
      width: result.screenWidth,
      height: result.screenHeight,
      compositionData
    }
  }

  /**
   * Clear internal caches.
   */
  clearCache(): void {
    this.renderer?.clearCache()
    this.cueMetadataCache.clear()
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.renderer?.dispose()
    this.renderer?.free()
    this.renderer = null
    this.timestamps = new Float64Array(0)
    this.cueMetadataCache.clear()
  }
}
