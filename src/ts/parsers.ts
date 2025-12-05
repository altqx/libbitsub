/**
 * Low-level subtitle parsers for libbitsub.
 * Use these for programmatic access to subtitle data without video integration.
 */

import type {
  SubtitleData,
  SubtitleCompositionData,
  SubtitleFrame,
  VobSubFrame,
  RenderResult,
  WasmPgsParser,
  WasmVobSubParser,
  WasmSubtitleRenderer
} from './types'
import { getWasm } from './wasm'

/**
 * Low-level PGS subtitle parser using WASM.
 * Use this for programmatic access to PGS data without video integration.
 */
export class PgsParser {
  private parser: WasmPgsParser | null = null
  private timestamps: Float64Array = new Float64Array(0)

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

      const imageData = new ImageData(clampedData, comp.width, comp.height)

      compositionData.push({
        pixelData: imageData,
        x: comp.x,
        y: comp.y
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
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.parser?.free()
    this.parser = null
    this.timestamps = new Float64Array(0)
  }
}

/**
 * Low-level VobSub subtitle parser using WASM.
 * Use this for programmatic access to VobSub data without video integration.
 */
export class VobSubParserLowLevel {
  private parser: WasmVobSubParser | null = null
  private timestamps: Float64Array = new Float64Array(0)

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
  }

  /**
   * Load VobSub from SUB file only.
   */
  loadFromSubOnly(subData: Uint8Array): void {
    if (!this.parser) throw new Error('Parser not initialized')
    this.parser.loadFromSubOnly(subData)
    this.timestamps = this.parser.getTimestamps()
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

    const imageData = new ImageData(clampedData, frame.width, frame.height)

    return {
      width: frame.screenWidth,
      height: frame.screenHeight,
      compositionData: [
        {
          pixelData: imageData,
          x: frame.x,
          y: frame.y
        }
      ]
    }
  }

  /**
   * Clear internal caches.
   */
  clearCache(): void {
    this.parser?.clearCache()
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.parser?.free()
    this.parser = null
    this.timestamps = new Float64Array(0)
  }
}

/**
 * Unified subtitle parser that handles both PGS and VobSub formats.
 */
export class UnifiedSubtitleParser {
  private renderer: WasmSubtitleRenderer | null = null
  private timestamps: Float64Array = new Float64Array(0)

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
    return count
  }

  /**
   * Load VobSub from IDX and SUB data.
   */
  loadVobSub(idxContent: string, subData: Uint8Array): void {
    if (!this.renderer) throw new Error('Renderer not initialized')
    this.renderer.loadVobSub(idxContent, subData)
    this.timestamps = this.renderer.getTimestamps()
  }

  /**
   * Load VobSub from SUB file only.
   */
  loadVobSubOnly(subData: Uint8Array): void {
    if (!this.renderer) throw new Error('Renderer not initialized')
    this.renderer.loadVobSubOnly(subData)
    this.timestamps = this.renderer.getTimestamps()
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

        const imageData = new ImageData(clampedData, width, height)

        compositionData.push({
          pixelData: imageData,
          x: result.getCompositionX(i),
          y: result.getCompositionY(i)
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
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this.renderer?.dispose()
    this.renderer?.free()
    this.renderer = null
    this.timestamps = new Float64Array(0)
  }
}
