/**
 * Low-level subtitle parsers for libbitsub.
 * Use these for programmatic access to subtitle data without video integration.
 */

import type {
  AutoSubtitleSource,
  SubtitleDiagnosticsOptions,
  SubtitleData,
  SubtitleDiagnosticWarning,
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
import {
  createSubtitleDiagnosticError,
  createSubtitleWarning,
  formatSubtitleWarningForConsole,
  normalizeSubtitleError,
  warningFromRenderIssue
} from './diagnostics'
import { getWasm } from './wasm'
import { detectSubtitleFormat, getSubtitleBounds, isMksSource, trimTransparentImageData } from './utils'

interface WasmVobSubParserWithMks extends WasmVobSubParser {
  loadFromMks(data: Uint8Array): void
}

interface WasmSubtitleRendererWithMks extends WasmSubtitleRenderer {
  loadVobSubMks(data: Uint8Array): void
}

/**
 * Low-level PGS subtitle parser using WASM.
 * Use this for programmatic access to PGS data without video integration.
 */
export class PgsParser {
  private parser: WasmPgsParser | null = null
  private timestamps: Float64Array = new Float64Array(0)
  private cueMetadataCache = new Map<number, SubtitleCueMetadata | null>()
  private readonly debug: boolean
  private readonly onWarning?: (warning: SubtitleDiagnosticWarning) => void

  constructor(options: SubtitleDiagnosticsOptions = {}) {
    const wasm = getWasm()
    this.parser = new wasm.PgsParser()
    this.debug = Boolean(options.debug)
    this.onWarning = options.onWarning
  }

  /**
   * Load PGS subtitle data from a Uint8Array.
   */
  load(data: Uint8Array): number {
    try {
      if (!this.parser) throw new Error('Parser not initialized')
      const count = this.parser.parse(data)
      this.timestamps = this.parser.getTimestamps()
      this.cueMetadataCache.clear()
      return count
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'pgs' })
    }
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
    if (!frame) {
      const warning = warningFromRenderIssue(this.getLastRenderIssue(), { format: 'pgs', cueIndex: index })
      if (warning) this.emitWarning(warning)
      return undefined
    }

    return this.convertFrame(frame)
  }

  getLastRenderIssue(): string | null {
    const issue = this.parser?.lastRenderIssue?.trim()
    return issue ? issue : null
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
        this.emitWarning(
          createSubtitleWarning('INVALID_FRAME_DATA', 'Invalid PGS composition buffer dimensions during frame conversion.', {
            format: 'pgs',
            details: {
              expectedLength,
              actualLength: rgba.length,
              width: comp.width,
              height: comp.height
            }
          })
        )
        continue
      }

      const trimmed = trimTransparentImageData(rgba, comp.width, comp.height)

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

  private emitWarning(warning: SubtitleDiagnosticWarning): void {
    this.onWarning?.(warning)

    if (this.debug && !this.onWarning) {
      console.warn(formatSubtitleWarningForConsole(warning), warning.details ?? {})
    }
  }
}

/**
 * Low-level VobSub subtitle parser using WASM.
 * Use this for programmatic access to VobSub data without video integration.
 */
export class VobSubParserLowLevel {
  private parser: WasmVobSubParserWithMks | null = null
  private timestamps: Float64Array = new Float64Array(0)
  private cueMetadataCache = new Map<number, SubtitleCueMetadata | null>()
  private readonly debug: boolean
  private readonly onWarning?: (warning: SubtitleDiagnosticWarning) => void

  constructor(options: SubtitleDiagnosticsOptions = {}) {
    const wasm = getWasm()
    this.parser = new wasm.VobSubParser() as WasmVobSubParserWithMks
    this.debug = Boolean(options.debug)
    this.onWarning = options.onWarning
  }

  /**
   * Load VobSub from IDX and SUB data.
   */
  loadFromData(idxContent: string, subData: Uint8Array): void {
    try {
      if (!this.parser) throw new Error('Parser not initialized')
      this.parser.loadFromData(idxContent, subData)
      this.timestamps = this.parser.getTimestamps()
      this.cueMetadataCache.clear()

      if (this.timestamps.length === 0 && idxContent.trim().length > 0) {
        throw createSubtitleDiagnosticError('BAD_IDX', 'IDX metadata did not yield any subtitle timestamps.', {
          format: 'vobsub'
        })
      }
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'vobsub', fallbackCode: 'BAD_IDX' })
    }
  }

  /**
   * Load VobSub from SUB file only.
   */
  loadFromSubOnly(subData: Uint8Array): void {
    try {
      if (!this.parser) throw new Error('Parser not initialized')
      this.parser.loadFromSubOnly(subData)
      this.timestamps = this.parser.getTimestamps()
      this.cueMetadataCache.clear()
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'vobsub' })
    }
  }

  /**
   * Load VobSub from an .mks Matroska subtitle container.
   */
  loadFromMks(mksData: Uint8Array): void {
    try {
      if (!this.parser) throw new Error('Parser not initialized')
      this.parser.loadFromMks(mksData)
      this.timestamps = this.parser.getTimestamps()
      this.cueMetadataCache.clear()
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'vobsub' })
    }
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
    if (!frame) {
      const warning = warningFromRenderIssue(this.getLastRenderIssue(), { format: 'vobsub', cueIndex: index })
      if (warning) this.emitWarning(warning)
      return undefined
    }

    return this.convertFrame(frame)
  }

  getLastRenderIssue(): string | null {
    const issue = this.parser?.lastRenderIssue?.trim()
    return issue ? issue : null
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
      this.emitWarning(
        createSubtitleWarning('INVALID_FRAME_DATA', 'Invalid VobSub frame buffer dimensions during frame conversion.', {
          format: 'vobsub',
          details: {
            expectedLength,
            actualLength: rgba.length,
            width: frame.width,
            height: frame.height
          }
        })
      )
      return {
        width: frame.screenWidth,
        height: frame.screenHeight,
        compositionData: []
      }
    }

    const trimmed = trimTransparentImageData(rgba, frame.width, frame.height)

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

  private emitWarning(warning: SubtitleDiagnosticWarning): void {
    this.onWarning?.(warning)

    if (this.debug && !this.onWarning) {
      console.warn(formatSubtitleWarningForConsole(warning), warning.details ?? {})
    }
  }
}

/**
 * Unified subtitle parser that handles both PGS and VobSub formats.
 */
export class UnifiedSubtitleParser {
  private renderer: WasmSubtitleRendererWithMks | null = null
  private timestamps: Float64Array = new Float64Array(0)
  private cueMetadataCache = new Map<number, SubtitleCueMetadata | null>()
  private readonly debug: boolean
  private readonly onWarning?: (warning: SubtitleDiagnosticWarning) => void

  constructor(options: SubtitleDiagnosticsOptions = {}) {
    const wasm = getWasm()
    this.renderer = new wasm.SubtitleRenderer() as WasmSubtitleRendererWithMks
    this.debug = Boolean(options.debug)
    this.onWarning = options.onWarning
  }

  /**
   * Load PGS subtitle data.
   */
  loadPgs(data: Uint8Array): number {
    try {
      if (!this.renderer) throw new Error('Renderer not initialized')
      const count = this.renderer.loadPgs(data)
      this.timestamps = this.renderer.getTimestamps()
      this.cueMetadataCache.clear()
      return count
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'pgs' })
    }
  }

  /**
   * Load VobSub from IDX and SUB data.
   */
  loadVobSub(idxContent: string, subData: Uint8Array): void {
    try {
      if (!this.renderer) throw new Error('Renderer not initialized')
      this.renderer.loadVobSub(idxContent, subData)
      this.timestamps = this.renderer.getTimestamps()
      this.cueMetadataCache.clear()

      if (this.timestamps.length === 0 && idxContent.trim().length > 0) {
        throw createSubtitleDiagnosticError('BAD_IDX', 'IDX metadata did not yield any subtitle timestamps.', {
          format: 'vobsub'
        })
      }
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'vobsub', fallbackCode: 'BAD_IDX' })
    }
  }

  /**
   * Load VobSub from SUB file only.
   */
  loadVobSubOnly(subData: Uint8Array): void {
    try {
      if (!this.renderer) throw new Error('Renderer not initialized')
      this.renderer.loadVobSubOnly(subData)
      this.timestamps = this.renderer.getTimestamps()
      this.cueMetadataCache.clear()
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'vobsub' })
    }
  }

  /**
   * Load VobSub from an .mks Matroska subtitle container.
   */
  loadVobSubMks(mksData: Uint8Array): void {
    try {
      if (!this.renderer) throw new Error('Renderer not initialized')
      this.renderer.loadVobSubMks(mksData)
      this.timestamps = this.renderer.getTimestamps()
      this.cueMetadataCache.clear()
    } catch (error) {
      throw normalizeSubtitleError(error, { format: 'vobsub' })
    }
  }

  /** Load subtitle data with automatic format detection. */
  loadAuto(source: AutoSubtitleSource): SubtitleFormatName {
    const format = detectSubtitleFormat(source)
    if (!format) {
      throw createSubtitleDiagnosticError('UNSUPPORTED_FORMAT', 'Unable to detect subtitle format.')
    }

    if (format === 'pgs') {
      const data = source.data ?? source.subData
      if (!data) {
        throw createSubtitleDiagnosticError('MISSING_INPUT', 'No binary subtitle data provided for PGS.', {
          format: 'pgs'
        })
      }
      this.loadPgs(data instanceof Uint8Array ? data : new Uint8Array(data))
      return 'pgs'
    }

    const subBinary = source.subData ?? source.data
    if (!subBinary) {
      throw createSubtitleDiagnosticError('MISSING_INPUT', 'No SUB binary data provided for VobSub.', {
        format: 'vobsub'
      })
    }

    const subData = subBinary instanceof Uint8Array ? subBinary : new Uint8Array(subBinary)

    if (source.idxContent) {
      this.loadVobSub(source.idxContent, subData)
    } else if (isMksSource(source)) {
      this.loadVobSubMks(subData)
    } else {
      this.loadVobSubOnly(subData)
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
    if (!result) {
      const warning = warningFromRenderIssue(this.getLastRenderIssue(), { format: this.format ?? undefined, cueIndex: index })
      if (warning) this.emitWarning(warning)
      return undefined
    }

    return this.convertResult(result)
  }

  getLastRenderIssue(): string | null {
    const issue = this.renderer?.lastRenderIssue?.trim()
    return issue ? issue : null
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
        const trimmed = trimTransparentImageData(rgba, width, height)

        if (!trimmed) {
          continue
        }

        compositionData.push({
          pixelData: trimmed.pixelData,
          x: result.getCompositionX(i) + trimmed.offsetX,
          y: result.getCompositionY(i) + trimmed.offsetY
        })
      } else if (width > 0 && height > 0) {
        this.emitWarning(
          createSubtitleWarning('INVALID_FRAME_DATA', 'Invalid unified subtitle render buffer dimensions during frame conversion.', {
            format: this.format ?? undefined,
            details: {
              expectedLength,
              actualLength: rgba.length,
              width,
              height
            }
          })
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

  private emitWarning(warning: SubtitleDiagnosticWarning): void {
    this.onWarning?.(warning)

    if (this.debug && !this.onWarning) {
      console.warn(formatSubtitleWarningForConsole(warning), warning.details ?? {})
    }
  }
}
