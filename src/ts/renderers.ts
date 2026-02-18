/**
 * High-level video-integrated subtitle renderers for libbitsub.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */

import type { SubtitleData, SubtitleDisplaySettings, VideoSubtitleOptions, VideoVobSubOptions } from './types'
import { initWasm } from './wasm'
import { getOrCreateWorker, sendToWorker } from './worker'
import { binarySearchTimestamp, convertFrameData, createWorkerState } from './utils'
import { PgsParser, VobSubParserLowLevel } from './parsers'
import { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer'
import { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'

/** Default display settings */
const DEFAULT_DISPLAY_SETTINGS: SubtitleDisplaySettings = {
  scale: 1.0,
  verticalOffset: 0
}

/** Performance statistics for subtitle renderer */
export interface SubtitleRendererStats {
  /** Total frames rendered since initialization */
  framesRendered: number
  /** Frames dropped due to slow rendering */
  framesDropped: number
  /** Average render time in milliseconds */
  avgRenderTime: number
  /** Maximum render time in milliseconds */
  maxRenderTime: number
  /** Minimum render time in milliseconds */
  minRenderTime: number
  /** Last render time in milliseconds */
  lastRenderTime: number
  /** Current FPS (renders per second) */
  renderFps: number
  /** Whether rendering is using web worker */
  usingWorker: boolean
  /** Number of cached frames */
  cachedFrames: number
  /** Number of pending renders */
  pendingRenders: number
  /** Total subtitle entries/display sets */
  totalEntries: number
  /** Current subtitle index being displayed */
  currentIndex: number
}

/**
 * Base class for video-integrated subtitle renderers.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */
abstract class BaseVideoSubtitleRenderer {
  protected video: HTMLVideoElement
  protected subUrl?: string
  protected subContent?: ArrayBuffer
  protected canvas: HTMLCanvasElement | null = null
  protected ctx: CanvasRenderingContext2D | null = null
  protected animationFrameId: number | null = null
  protected isLoaded: boolean = false
  protected lastRenderedIndex: number = -1
  protected lastRenderedTime: number = -1
  protected disposed: boolean = false
  protected resizeObserver: ResizeObserver | null = null
  protected tempCanvas: HTMLCanvasElement | null = null
  protected tempCtx: CanvasRenderingContext2D | null = null
  protected lastRenderedData: SubtitleData | null = null

  /** Display settings for subtitle rendering */
  protected displaySettings: SubtitleDisplaySettings = { ...DEFAULT_DISPLAY_SETTINGS }

  // WebGPU renderer (optional, falls back to WebGL2 then Canvas2D)
  protected webgpuRenderer: WebGPURenderer | null = null
  protected useWebGPU: boolean = false
  protected onWebGPUFallback?: () => void

  // WebGL2 renderer (optional, falls back to Canvas2D)
  protected webgl2Renderer: WebGL2Renderer | null = null
  protected useWebGL2: boolean = false
  protected onWebGL2Fallback?: () => void

  // Performance tracking
  protected perfStats = {
    framesRendered: 0,
    framesDropped: 0,
    renderTimes: [] as number[],
    lastRenderTime: 0,
    fpsTimestamps: [] as number[],
    lastFrameTime: 0
  }

  constructor(options: VideoSubtitleOptions) {
    this.video = options.video
    this.subUrl = options.subUrl
    this.subContent = options.subContent
    this.onWebGPUFallback = options.onWebGPUFallback
    this.onWebGL2Fallback = options.onWebGL2Fallback
  }

  /** Get current display settings */
  getDisplaySettings(): SubtitleDisplaySettings {
    return { ...this.displaySettings }
  }

  /** Get performance statistics */
  abstract getStats(): SubtitleRendererStats

  /** Get base stats common to all renderers */
  protected getBaseStats(): Omit<
    SubtitleRendererStats,
    'usingWorker' | 'cachedFrames' | 'pendingRenders' | 'totalEntries'
  > {
    const now = performance.now()
    // Clean up old FPS timestamps (keep last second)
    this.perfStats.fpsTimestamps = this.perfStats.fpsTimestamps.filter((t) => now - t < 1000)

    const renderTimes = this.perfStats.renderTimes
    const avgRenderTime = renderTimes.length > 0 ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length : 0
    const maxRenderTime = renderTimes.length > 0 ? Math.max(...renderTimes) : 0
    const minRenderTime = renderTimes.length > 0 ? Math.min(...renderTimes) : 0

    return {
      framesRendered: this.perfStats.framesRendered,
      framesDropped: this.perfStats.framesDropped,
      avgRenderTime: Math.round(avgRenderTime * 100) / 100,
      maxRenderTime: Math.round(maxRenderTime * 100) / 100,
      minRenderTime: Math.round(minRenderTime * 100) / 100,
      lastRenderTime: Math.round(this.perfStats.lastRenderTime * 100) / 100,
      renderFps: this.perfStats.fpsTimestamps.length,
      currentIndex: this.lastRenderedIndex
    }
  }

  /** Set display settings and force re-render */
  setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void {
    const changed =
      settings.scale !== this.displaySettings.scale || settings.verticalOffset !== this.displaySettings.verticalOffset

    if (settings.scale !== undefined) {
      this.displaySettings.scale = Math.max(0.1, Math.min(3.0, settings.scale))
    }
    if (settings.verticalOffset !== undefined) {
      this.displaySettings.verticalOffset = Math.max(-50, Math.min(50, settings.verticalOffset))
    }

    // Force re-render if settings changed
    if (changed) {
      this.lastRenderedIndex = -1
      this.lastRenderedTime = -1
    }
  }

  /** Reset display settings to defaults */
  resetDisplaySettings(): void {
    this.displaySettings = { ...DEFAULT_DISPLAY_SETTINGS }
    this.lastRenderedIndex = -1
    this.lastRenderedTime = -1
  }

  /** Start initialization. */
  protected startInit(): void {
    this.init()
  }

  /** Initialize the renderer. */
  protected async init(): Promise<void> {
    await initWasm()
    this.createCanvas()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await this.loadSubtitles()
    this.startRenderLoop()
  }

  /** Create the canvas overlay positioned over the video. */
  protected createCanvas(): void {
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '10'
    })

    const parent = this.video.parentElement
    if (parent) {
      if (window.getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative'
      }
      parent.appendChild(this.canvas)
    }

    // Try WebGPU first, then WebGL2, then Canvas2D
    if (isWebGPUSupported()) {
      this.initWebGPU()
    } else if (isWebGL2Supported()) {
      this.initWebGL2()
    } else {
      this.initCanvas2D()
    }

    this.updateCanvasSize()

    this.resizeObserver = new ResizeObserver(() => this.updateCanvasSize())
    this.resizeObserver.observe(this.video)
    this.video.addEventListener('loadedmetadata', () => this.updateCanvasSize())
    this.video.addEventListener('seeked', () => {
      this.lastRenderedIndex = -1
      this.lastRenderedTime = -1
      this.onSeek()
    })
  }

  /** Initialize WebGPU renderer. */
  private async initWebGPU(): Promise<void> {
    try {
      this.webgpuRenderer = new WebGPURenderer()
      await this.webgpuRenderer.init()

      if (!this.canvas) return

      const bounds = this.getVideoContentBounds()
      const width = Math.max(1, bounds.width * window.devicePixelRatio)
      const height = Math.max(1, bounds.height * window.devicePixelRatio)

      await this.webgpuRenderer.setCanvas(this.canvas, width, height)
      this.useWebGPU = true
      console.log('[libbitsub] Using WebGPU renderer')
    } catch (error) {
      console.warn('[libbitsub] WebGPU init failed, falling back to WebGL2:', error)
      this.webgpuRenderer?.destroy()
      this.webgpuRenderer = null
      this.useWebGPU = false
      this.onWebGPUFallback?.()
      // Try WebGL2 before Canvas2D
      if (isWebGL2Supported()) {
        this.initWebGL2()
      } else {
        this.initCanvas2D()
      }
    }
  }

  /** Initialize WebGL2 renderer. */
  private async initWebGL2(): Promise<void> {
    try {
      this.webgl2Renderer = new WebGL2Renderer()
      await this.webgl2Renderer.init()

      if (!this.canvas) return

      const bounds = this.getVideoContentBounds()
      const width = Math.max(1, bounds.width * window.devicePixelRatio)
      const height = Math.max(1, bounds.height * window.devicePixelRatio)

      await this.webgl2Renderer.setCanvas(this.canvas, width, height)
      this.useWebGL2 = true
      console.log('[libbitsub] Using WebGL2 renderer')
    } catch (error) {
      console.warn('[libbitsub] WebGL2 init failed, falling back to Canvas2D:', error)
      this.webgl2Renderer?.destroy()
      this.webgl2Renderer = null
      this.useWebGL2 = false
      this.onWebGL2Fallback?.()
      this.initCanvas2D()
    }
  }

  /** Initialize Canvas2D renderer. */
  private initCanvas2D(): void {
    if (!this.canvas) return
    this.ctx = this.canvas.getContext('2d')
    this.useWebGPU = false
    this.useWebGL2 = false
    console.log('[libbitsub] Using Canvas2D renderer')
  }

  /** Called when video seeks. */
  protected onSeek(): void {}

  /** Calculate the actual video content bounds, accounting for letterboxing/pillarboxing */
  protected getVideoContentBounds(): { x: number; y: number; width: number; height: number } {
    const rect = this.video.getBoundingClientRect()
    const videoWidth = this.video.videoWidth || rect.width
    const videoHeight = this.video.videoHeight || rect.height

    // Calculate aspect ratios
    const elementAspect = rect.width / rect.height
    const videoAspect = videoWidth / videoHeight

    let contentWidth: number
    let contentHeight: number
    let contentX: number
    let contentY: number

    if (Math.abs(elementAspect - videoAspect) < 0.01) {
      // Aspect ratios match - video fills the element
      contentWidth = rect.width
      contentHeight = rect.height
      contentX = 0
      contentY = 0
    } else if (elementAspect > videoAspect) {
      // Element is wider than video - pillarboxing (black bars on sides)
      contentHeight = rect.height
      contentWidth = rect.height * videoAspect
      contentX = (rect.width - contentWidth) / 2
      contentY = 0
    } else {
      // Element is taller than video - letterboxing (black bars top/bottom)
      contentWidth = rect.width
      contentHeight = rect.width / videoAspect
      contentX = 0
      contentY = (rect.height - contentHeight) / 2
    }

    return { x: contentX, y: contentY, width: contentWidth, height: contentHeight }
  }

  /** Update canvas size to match video content area. */
  protected updateCanvasSize(): void {
    if (!this.canvas) return

    const bounds = this.getVideoContentBounds()
    const width = bounds.width > 0 ? bounds.width : this.video.videoWidth || 1920
    const height = bounds.height > 0 ? bounds.height : this.video.videoHeight || 1080

    const pixelWidth = Math.max(1, width * window.devicePixelRatio)
    const pixelHeight = Math.max(1, height * window.devicePixelRatio)

    this.canvas.width = pixelWidth
    this.canvas.height = pixelHeight

    // Position canvas to match video content area
    this.canvas.style.left = `${bounds.x}px`
    this.canvas.style.top = `${bounds.y}px`
    this.canvas.style.width = `${bounds.width}px`
    this.canvas.style.height = `${bounds.height}px`

    // Update GPU renderer size if active
    if (this.useWebGPU && this.webgpuRenderer) {
      this.webgpuRenderer.updateSize(pixelWidth, pixelHeight)
    } else if (this.useWebGL2 && this.webgl2Renderer) {
      this.webgl2Renderer.updateSize(pixelWidth, pixelHeight)
    }

    this.lastRenderedIndex = -1
    this.lastRenderedTime = -1
  }

  protected abstract loadSubtitles(): Promise<void>
  protected abstract renderAtTime(time: number): SubtitleData | undefined
  protected abstract findCurrentIndex(time: number): number
  protected abstract renderAtIndex(index: number): SubtitleData | undefined

  /** Check if a render is pending for the given index (async loading in progress) */
  protected abstract isPendingRender(index: number): boolean

  /** Start the render loop. */
  protected startRenderLoop(): void {
    // Create reusable temp canvas for rendering
    this.tempCanvas = document.createElement('canvas')
    this.tempCtx = this.tempCanvas.getContext('2d')

    const render = () => {
      if (this.disposed) return

      if (this.isLoaded) {
        const currentTime = this.video.currentTime
        const currentIndex = this.findCurrentIndex(currentTime)

        // Only re-render if index changed
        if (currentIndex !== this.lastRenderedIndex) {
          const startTime = performance.now()
          this.renderFrame(currentTime, currentIndex)
          const endTime = performance.now()

          // Track performance
          const renderTime = endTime - startTime
          this.perfStats.lastRenderTime = renderTime
          this.perfStats.renderTimes.push(renderTime)
          // Keep only last 60 samples for rolling average
          if (this.perfStats.renderTimes.length > 60) {
            this.perfStats.renderTimes.shift()
          }
          this.perfStats.framesRendered++
          this.perfStats.fpsTimestamps.push(endTime)

          // Check for frame drop (if render took longer than frame budget ~16.67ms for 60fps)
          const frameBudget = 16.67
          if (renderTime > frameBudget) {
            this.perfStats.framesDropped++
          }

          this.lastRenderedIndex = currentIndex
          this.lastRenderedTime = currentTime
        }
      }

      this.animationFrameId = requestAnimationFrame(render)
    }

    this.animationFrameId = requestAnimationFrame(render)
  }

  /** Render a subtitle frame to the canvas. */
  protected renderFrame(time: number, index: number): void {
    if (!this.canvas) return

    // Get the data for this index
    const data = index >= 0 ? this.renderAtIndex(index) : undefined

    // If data is undefined, it means async loading is in progress
    // Keep showing the last frame only while waiting for async data
    // Note: null means "loaded but empty" (clear screen), undefined means "still loading"
    if (data === undefined && this.lastRenderedData !== null && index >= 0) {
      // Check if this index has a pending render (truly async loading)
      // If not pending, it means the render returned no data immediately
      if (this.isPendingRender(index)) {
        // Don't clear - keep showing the last frame while loading
        return
      }
    }

    // Use best available renderer
    if (this.useWebGPU && this.webgpuRenderer) {
      this.renderFrameWebGPU(data, index)
    } else if (this.useWebGL2 && this.webgl2Renderer) {
      this.renderFrameWebGL2(data, index)
    } else {
      this.renderFrameCanvas2D(data, index)
    }
  }

  /** Render using WebGPU. */
  private renderFrameWebGPU(data: SubtitleData | undefined, index: number): void {
    if (!this.webgpuRenderer || !this.canvas) return

    // If no subtitle at this index, clear
    if (index < 0 || !data || data.compositionData.length === 0) {
      this.webgpuRenderer.clear()
      this.lastRenderedData = null
      return
    }

    // Store for potential reuse
    this.lastRenderedData = data

    // Calculate base scale factors
    const baseScaleX = this.canvas.width / data.width
    const baseScaleY = this.canvas.height / data.height

    // Apply display settings
    const { scale, verticalOffset } = this.displaySettings
    const scaleX = baseScaleX * scale
    const scaleY = baseScaleY * scale
    const offsetY = (verticalOffset / 100) * this.canvas.height

    this.webgpuRenderer.render(data.compositionData, data.width, data.height, scaleX, scaleY, offsetY)
  }

  /** Render using WebGL2. */
  private renderFrameWebGL2(data: SubtitleData | undefined, index: number): void {
    if (!this.webgl2Renderer || !this.canvas) return

    if (index < 0 || !data || data.compositionData.length === 0) {
      this.webgl2Renderer.clear()
      this.lastRenderedData = null
      return
    }

    this.lastRenderedData = data

    const baseScaleX = this.canvas.width / data.width
    const baseScaleY = this.canvas.height / data.height

    const { scale, verticalOffset } = this.displaySettings
    const scaleX = baseScaleX * scale
    const scaleY = baseScaleY * scale
    const offsetY = (verticalOffset / 100) * this.canvas.height

    this.webgl2Renderer.render(data.compositionData, data.width, data.height, scaleX, scaleY, offsetY)
  }

  /** Render using Canvas2D. */
  private renderFrameCanvas2D(data: SubtitleData | undefined, index: number): void {
    if (!this.ctx || !this.canvas) return

    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    // If no subtitle at this index, we're done
    if (index < 0 || !data || data.compositionData.length === 0) {
      this.lastRenderedData = null
      return
    }

    // Store for potential reuse
    this.lastRenderedData = data

    // Calculate base scale factors
    const baseScaleX = this.canvas.width / data.width
    const baseScaleY = this.canvas.height / data.height

    // Apply display settings
    const { scale, verticalOffset } = this.displaySettings
    const scaleX = baseScaleX * scale
    const scaleY = baseScaleY * scale
    const offsetY = (verticalOffset / 100) * this.canvas.height

    for (const comp of data.compositionData) {
      if (!this.tempCanvas || !this.tempCtx) continue

      // Resize temp canvas if needed
      if (this.tempCanvas.width !== comp.pixelData.width || this.tempCanvas.height !== comp.pixelData.height) {
        this.tempCanvas.width = comp.pixelData.width
        this.tempCanvas.height = comp.pixelData.height
      }

      this.tempCtx.putImageData(comp.pixelData, 0, 0)

      // Calculate position with scale and offset applied
      // Center the scaled content horizontally
      const scaledWidth = comp.pixelData.width * scaleX
      const scaledHeight = comp.pixelData.height * scaleY
      const baseX = comp.x * baseScaleX
      const baseY = comp.y * baseScaleY
      const centeredX = baseX + (comp.pixelData.width * baseScaleX - scaledWidth) / 2
      const adjustedY = baseY + offsetY + (comp.pixelData.height * baseScaleY - scaledHeight)

      this.ctx.drawImage(this.tempCanvas, centeredX, adjustedY, scaledWidth, scaledHeight)
    }
  }

  /** Dispose of all resources. */
  dispose(): void {
    this.disposed = true

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }

    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    // Clean up GPU renderers
    if (this.webgpuRenderer) {
      this.webgpuRenderer.destroy()
      this.webgpuRenderer = null
    }
    if (this.webgl2Renderer) {
      this.webgl2Renderer.destroy()
      this.webgl2Renderer = null
    }

    this.canvas?.parentElement?.removeChild(this.canvas)
    this.canvas = null
    this.ctx = null
    this.tempCanvas = null
    this.tempCtx = null
    this.lastRenderedData = null
    this.useWebGPU = false
    this.useWebGL2 = false
  }
}

/**
 * High-level PGS subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */
export class PgsRenderer extends BaseVideoSubtitleRenderer {
  private pgsParser: PgsParser | null = null
  private state = createWorkerState()
  private onLoading?: () => void
  private onLoaded?: () => void
  private onError?: (error: Error) => void

  constructor(options: VideoSubtitleOptions) {
    super(options)
    this.onLoading = options.onLoading
    this.onLoaded = options.onLoaded
    this.onError = options.onError
    this.startInit()
  }

  protected async loadSubtitles(): Promise<void> {
    try {
      this.onLoading?.()

      let arrayBuffer: ArrayBuffer
      if (this.subContent) {
        arrayBuffer = this.subContent
      } else if (this.subUrl) {
        const response = await fetch(this.subUrl)
        if (!response.ok) throw new Error(`Failed to fetch subtitle: ${response.status}`)
        arrayBuffer = await response.arrayBuffer()
      } else {
        throw new Error('No subtitle content or URL provided')
      }

      const data = new Uint8Array(arrayBuffer)

      if (this.state.useWorker) {
        try {
          await getOrCreateWorker()
          const loadResponse = await sendToWorker({ type: 'loadPgs', data: data.buffer.slice(0) })

          if (loadResponse.type === 'pgsLoaded') {
            this.state.workerReady = true
            const tsResponse = await sendToWorker({ type: 'getPgsTimestamps' })
            if (tsResponse.type === 'pgsTimestamps') {
              this.state.timestamps = tsResponse.timestamps
            }
            this.isLoaded = true
            console.log(
              `[libbitsub] PGS loaded (worker): ${loadResponse.count} display sets from ${loadResponse.byteLength} bytes`
            )
            this.onLoaded?.()
            return // Success, don't fall through to main thread
          } else if (loadResponse.type === 'error') {
            throw new Error(loadResponse.message)
          }
        } catch (workerError) {
          console.warn('[libbitsub] Worker failed, falling back to main thread:', workerError)
          this.state.useWorker = false
        }
      }

      // Main thread fallback - use idle callback to avoid blocking UI
      await this.loadOnMainThread(data)
      this.onLoaded?.()
    } catch (error) {
      console.error('Failed to load PGS subtitles:', error)
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async loadOnMainThread(data: Uint8Array): Promise<void> {
    // Yield to browser before heavy parsing
    await this.yieldToMain()

    this.pgsParser = new PgsParser()

    // Parse in a microtask to allow UI to update
    await new Promise<void>((resolve) => {
      // Use requestIdleCallback if available, otherwise setTimeout
      const scheduleTask =
        typeof requestIdleCallback !== 'undefined'
          ? (cb: () => void) => requestIdleCallback(() => cb(), { timeout: 1000 })
          : (cb: () => void) => setTimeout(cb, 0)

      scheduleTask(() => {
        const count = this.pgsParser!.load(data)
        this.state.timestamps = this.pgsParser!.getTimestamps()
        this.isLoaded = true
        console.log(`[libbitsub] PGS loaded (main thread): ${count} display sets from ${data.byteLength} bytes`)
        resolve()
      })
    })
  }

  /** Yield to main thread to prevent UI blocking */
  private yieldToMain(): Promise<void> {
    // Use scheduler.yield if available (Chrome 115+)
    const globalScheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler
    if (globalScheduler && typeof globalScheduler.yield === 'function') {
      return globalScheduler.yield()
    }
    // Fallback to setTimeout
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  protected renderAtTime(time: number): SubtitleData | undefined {
    const index = this.findCurrentIndex(time)
    return index < 0 ? undefined : this.renderAtIndex(index)
  }

  protected findCurrentIndex(time: number): number {
    if (this.state.useWorker && this.state.workerReady) {
      return binarySearchTimestamp(this.state.timestamps, time * 1000)
    }
    return this.pgsParser?.findIndexAtTimestamp(time) ?? -1
  }

  protected renderAtIndex(index: number): SubtitleData | undefined {
    if (this.state.useWorker && this.state.workerReady) {
      if (this.state.frameCache.has(index)) {
        return this.state.frameCache.get(index) ?? undefined
      }

      if (!this.state.pendingRenders.has(index)) {
        const renderPromise = sendToWorker({ type: 'renderPgsAtIndex', index }).then((response) =>
          response.type === 'pgsFrame' && response.frame ? convertFrameData(response.frame) : null
        )

        this.state.pendingRenders.set(index, renderPromise)
        renderPromise.then((result) => {
          this.state.frameCache.set(index, result)
          this.state.pendingRenders.delete(index)
          // Force re-render on next frame by resetting lastRenderedIndex
          if (this.findCurrentIndex(this.video.currentTime) === index) {
            this.lastRenderedIndex = -1
          }
        })
      }
      // Return undefined to indicate async loading in progress
      return undefined
    }
    return this.pgsParser?.renderAtIndex(index)
  }

  protected isPendingRender(index: number): boolean {
    return this.state.pendingRenders.has(index)
  }

  protected onSeek(): void {
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearPgsCache' }).catch(() => {})
    }
    this.pgsParser?.clearCache()
  }

  /** Get performance statistics for PGS renderer */
  getStats(): SubtitleRendererStats {
    const baseStats = this.getBaseStats()
    return {
      ...baseStats,
      usingWorker: this.state.useWorker && this.state.workerReady,
      cachedFrames: this.state.frameCache.size,
      pendingRenders: this.state.pendingRenders.size,
      totalEntries: this.state.timestamps.length || (this.pgsParser?.getTimestamps().length ?? 0)
    }
  }

  dispose(): void {
    super.dispose()
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'disposePgs' }).catch(() => {})
    }
    this.pgsParser?.dispose()
    this.pgsParser = null
  }
}

/**
 * High-level VobSub subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */
export class VobSubRenderer extends BaseVideoSubtitleRenderer {
  private vobsubParser: VobSubParserLowLevel | null = null
  private idxUrl?: string
  private idxContent?: string
  private state = createWorkerState()
  private onLoading?: () => void
  private onLoaded?: () => void
  private onError?: (error: Error) => void

  // Async index lookup state
  private cachedIndex: number = -1
  private cachedIndexTime: number = -1
  private pendingIndexLookup: Promise<number> | null = null

  constructor(options: VideoVobSubOptions) {
    super(options)
    this.idxUrl = options.idxUrl || (options.subUrl ? options.subUrl.replace(/\\.sub$/i, '.idx') : undefined)
    this.idxContent = options.idxContent
    this.onLoading = options.onLoading
    this.onLoaded = options.onLoaded
    this.onError = options.onError
    this.startInit()
  }

  protected async loadSubtitles(): Promise<void> {
    try {
      this.onLoading?.()

      console.log(`[libbitsub] Loading VobSub`)

      let subArrayBuffer: ArrayBuffer | undefined
      let idxData: string | undefined

      // Resolve SUB content
      if (this.subContent) {
        subArrayBuffer = this.subContent
      }

      // Resolve IDX content
      if (this.idxContent) {
        idxData = this.idxContent
      }

      // Fetch missing parts
      const promises: Promise<void>[] = []

      if (!subArrayBuffer) {
        if (!this.subUrl) throw new Error('No SUB content or URL provided')
        promises.push(
          fetch(this.subUrl)
            .then((r) => {
              if (!r.ok) throw new Error(`Failed to fetch .sub file: ${r.status}`)
              return r.arrayBuffer()
            })
            .then((b) => {
              subArrayBuffer = b
            })
        )
      }

      if (!idxData) {
        if (!this.idxUrl) throw new Error('No IDX content or URL provided')
        promises.push(
          fetch(this.idxUrl)
            .then((r) => {
              if (!r.ok) throw new Error(`Failed to fetch .idx file: ${r.status}`)
              return r.text()
            })
            .then((t) => {
              idxData = t
            })
        )
      }

      if (promises.length > 0) {
        await Promise.all(promises)
      }

      if (!subArrayBuffer || !idxData) {
        throw new Error('Failed to load VobSub data')
      }

      const subData = new Uint8Array(subArrayBuffer)

      console.log(
        `[libbitsub] VobSub files loaded: .sub=${subArrayBuffer.byteLength} bytes, .idx=${idxData.length} chars`
      )

      if (this.state.useWorker) {
        try {
          await getOrCreateWorker()
          const loadResponse = await sendToWorker({
            type: 'loadVobSub',
            idxContent: idxData,
            subData: subData.buffer.slice(0)
          })

          if (loadResponse.type === 'vobSubLoaded') {
            this.state.workerReady = true
            const tsResponse = await sendToWorker({ type: 'getVobSubTimestamps' })
            if (tsResponse.type === 'vobSubTimestamps') {
              this.state.timestamps = tsResponse.timestamps
            }
            this.isLoaded = true
            console.log(`[libbitsub] VobSub loaded (worker): ${loadResponse.count} subtitle entries`)
            this.onLoaded?.()
            return // Success, don't fall through to main thread
          } else if (loadResponse.type === 'error') {
            throw new Error(loadResponse.message)
          }
        } catch (workerError) {
          console.warn('[libbitsub] Worker failed, falling back to main thread:', workerError)
          this.state.useWorker = false
        }
      }

      // Main thread fallback
      await this.loadOnMainThread(idxData, subData)
      this.onLoaded?.()
    } catch (error) {
      console.error('Failed to load VobSub subtitles:', error)
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async loadOnMainThread(idxData: string, subData: Uint8Array): Promise<void> {
    // Yield to browser before heavy parsing
    await this.yieldToMain()

    this.vobsubParser = new VobSubParserLowLevel()

    // Parse in a microtask to allow UI to update
    await new Promise<void>((resolve) => {
      const scheduleTask =
        typeof requestIdleCallback !== 'undefined'
          ? (cb: () => void) => requestIdleCallback(() => cb(), { timeout: 1000 })
          : (cb: () => void) => setTimeout(cb, 0)

      scheduleTask(() => {
        this.vobsubParser!.loadFromData(idxData, subData)
        this.state.timestamps = this.vobsubParser!.getTimestamps()
        console.log(`[libbitsub] VobSub loaded (main thread): ${this.vobsubParser!.count} subtitle entries`)
        this.isLoaded = true
        resolve()
      })
    })
  }

  /** Yield to main thread to prevent UI blocking */
  private yieldToMain(): Promise<void> {
    const globalScheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler
    if (globalScheduler && typeof globalScheduler.yield === 'function') {
      return globalScheduler.yield()
    }
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  protected renderAtTime(time: number): SubtitleData | undefined {
    const index = this.findCurrentIndex(time)
    return index < 0 ? undefined : this.renderAtIndex(index)
  }

  protected findCurrentIndex(time: number): number {
    if (this.state.useWorker && this.state.workerReady) {
      const timeMs = time * 1000

      // Only use cache if time is very close (within 1 frame)
      const timeDelta = timeMs - this.cachedIndexTime
      const cacheValid = this.cachedIndexTime >= 0 && Math.abs(timeDelta) < 17

      if (cacheValid) {
        return this.cachedIndex
      }

      // Start async lookup if not already pending
      if (!this.pendingIndexLookup) {
        this.pendingIndexLookup = sendToWorker({ type: 'findVobSubIndex', timeMs }).then((response) => {
          if (response.type === 'vobSubIndex') {
            const newIndex = response.index
            const oldIndex = this.cachedIndex
            this.cachedIndex = newIndex
            this.cachedIndexTime = timeMs

            // Force re-render if index changed (including to -1 for clear)
            if (oldIndex !== newIndex) {
              this.lastRenderedIndex = -2 // Use -2 to force update even when new index is -1
            }
          }
          this.pendingIndexLookup = null
          return this.cachedIndex
        })
      }

      return this.cachedIndex
    }
    return this.vobsubParser?.findIndexAtTimestamp(time) ?? -1
  }

  protected renderAtIndex(index: number): SubtitleData | undefined {
    if (this.state.useWorker && this.state.workerReady) {
      // Return cached frame immediately if available
      if (this.state.frameCache.has(index)) {
        return this.state.frameCache.get(index) ?? undefined
      }

      // Start async render if not already pending
      if (!this.state.pendingRenders.has(index)) {
        const renderPromise = sendToWorker({ type: 'renderVobSubAtIndex', index }).then((response) =>
          response.type === 'vobSubFrame' && response.frame ? convertFrameData(response.frame) : null
        )

        this.state.pendingRenders.set(index, renderPromise)
        renderPromise.then((result) => {
          this.state.frameCache.set(index, result)
          this.state.pendingRenders.delete(index)
          // Force re-render on next frame by resetting lastRenderedIndex
          if (this.findCurrentIndex(this.video.currentTime) === index) {
            this.lastRenderedIndex = -1
          }
        })
      }
      // Return undefined to indicate async loading in progress
      return undefined
    }
    return this.vobsubParser?.renderAtIndex(index)
  }

  protected isPendingRender(index: number): boolean {
    return this.state.pendingRenders.has(index)
  }

  protected onSeek(): void {
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    // Clear cached index lookup on seek
    this.cachedIndex = -1
    this.cachedIndexTime = -1
    this.pendingIndexLookup = null
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearVobSubCache' }).catch(() => {})
    }
    this.vobsubParser?.clearCache()
  }

  /** Get performance statistics for VobSub renderer */
  getStats(): SubtitleRendererStats {
    const baseStats = this.getBaseStats()
    return {
      ...baseStats,
      usingWorker: this.state.useWorker && this.state.workerReady,
      cachedFrames: this.state.frameCache.size,
      pendingRenders: this.state.pendingRenders.size,
      totalEntries: this.state.timestamps.length || (this.vobsubParser?.getTimestamps().length ?? 0)
    }
  }

  /** Enable or disable debanding filter */
  setDebandEnabled(enabled: boolean): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandEnabled', enabled }).catch(() => {})
    }
    this.vobsubParser?.setDebandEnabled(enabled)
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.lastRenderedIndex = -1
  }

  /** Set debanding threshold (0-255, default: 64) */
  setDebandThreshold(threshold: number): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandThreshold', threshold }).catch(() => {})
    }
    this.vobsubParser?.setDebandThreshold(threshold)
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.lastRenderedIndex = -1
  }

  /** Set debanding sample range in pixels (1-64, default: 15) */
  setDebandRange(range: number): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandRange', range }).catch(() => {})
    }
    this.vobsubParser?.setDebandRange(range)
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.lastRenderedIndex = -1
  }

  /** Check if debanding is enabled */
  get debandEnabled(): boolean {
    return this.vobsubParser?.debandEnabled ?? true
  }

  dispose(): void {
    super.dispose()
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'disposeVobSub' }).catch(() => {})
    }
    this.vobsubParser?.dispose()
    this.vobsubParser = null
  }
}
