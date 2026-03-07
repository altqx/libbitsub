/**
 * High-level video-integrated subtitle renderers for libbitsub.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */

import type {
  AutoVideoSubtitleOptions,
  SubtitleCueMetadata,
  SubtitleData,
  SubtitleDisplaySettings,
  SubtitleParserMetadata,
  SubtitleRendererBackend,
  SubtitleRendererEvent,
  VideoSubtitleOptions,
  VideoVobSubOptions
} from './types'
import { initWasm } from './wasm'
import { getOrCreateWorker, sendToWorker } from './worker'
import {
  binarySearchTimestamp,
  convertFrameData,
  createWorkerSessionId,
  createWorkerState,
  detectSubtitleFormat,
  getSubtitleBounds,
  setCacheLimit as applyCacheLimit,
  setCachedFrame
} from './utils'
import { PgsParser, VobSubParserLowLevel } from './parsers'
import { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer'
import { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'

/** Default display settings */
const DEFAULT_DISPLAY_SETTINGS: SubtitleDisplaySettings = {
  scale: 1.0,
  verticalOffset: 0,
  horizontalOffset: 0,
  horizontalAlign: 'center',
  bottomPadding: 0,
  safeArea: 0,
  opacity: 1.0
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
  protected readonly format: 'pgs' | 'vobsub'
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
  protected lastCueIndex: number | null = null
  protected currentCueMetadata: SubtitleCueMetadata | null = null
  protected parserMetadata: SubtitleParserMetadata | null = null

  /** Display settings for subtitle rendering */
  protected displaySettings: SubtitleDisplaySettings = { ...DEFAULT_DISPLAY_SETTINGS }
  protected cacheLimit: number = 24
  protected prefetchBefore: number = 0
  protected prefetchAfter: number = 0
  protected onEvent?: (event: SubtitleRendererEvent) => void
  protected currentRendererBackend: SubtitleRendererBackend | null = null

  private loadedMetadataHandler: (() => void) | null = null
  private seekedHandler: (() => void) | null = null

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

  constructor(options: VideoSubtitleOptions, format: 'pgs' | 'vobsub') {
    this.video = options.video
    this.format = format
    this.subUrl = options.subUrl
    this.subContent = options.subContent
    this.onWebGPUFallback = options.onWebGPUFallback
    this.onWebGL2Fallback = options.onWebGL2Fallback
    this.onEvent = options.onEvent
    this.displaySettings = { ...DEFAULT_DISPLAY_SETTINGS, ...options.displaySettings }
    this.cacheLimit = Math.max(0, Math.floor(options.cacheLimit ?? 24))
    this.prefetchBefore = Math.max(0, Math.floor(options.prefetchWindow?.before ?? 0))
    this.prefetchAfter = Math.max(0, Math.floor(options.prefetchWindow?.after ?? 0))
  }

  /** Get current display settings */
  getDisplaySettings(): SubtitleDisplaySettings {
    return { ...this.displaySettings }
  }

  /** Get performance statistics */
  abstract getStats(): SubtitleRendererStats

  /** Get parser metadata for the active subtitle track. */
  getMetadata(): SubtitleParserMetadata | null {
    return this.parserMetadata
  }

  /** Get the most recently displayed cue metadata. */
  getCurrentCueMetadata(): SubtitleCueMetadata | null {
    return this.currentCueMetadata
  }

  /** Get cue metadata for the specified index. */
  getCueMetadata(index: number): SubtitleCueMetadata | null {
    return this.buildCueMetadata(index)
  }

  /** Get the configured frame-cache limit. */
  getCacheLimit(): number {
    return this.cacheLimit
  }

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
    const nextSettings = {
      ...this.displaySettings,
      ...settings
    }

    nextSettings.scale = Math.max(0.1, Math.min(3.0, nextSettings.scale))
    nextSettings.verticalOffset = Math.max(-50, Math.min(50, nextSettings.verticalOffset))
    nextSettings.horizontalOffset = Math.max(-50, Math.min(50, nextSettings.horizontalOffset))
    nextSettings.bottomPadding = Math.max(0, Math.min(50, nextSettings.bottomPadding))
    nextSettings.safeArea = Math.max(0, Math.min(25, nextSettings.safeArea))
    nextSettings.opacity = Math.max(0, Math.min(1, nextSettings.opacity))

    const changed = JSON.stringify(nextSettings) !== JSON.stringify(this.displaySettings)
    this.displaySettings = nextSettings

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
    this.init().catch((error) => {
      this.emitEvent({ type: 'error', format: this.format, error: error instanceof Error ? error : new Error(String(error)) })
    })
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
    this.loadedMetadataHandler = () => this.updateCanvasSize()
    this.seekedHandler = () => {
      this.lastRenderedIndex = -1
      this.lastRenderedTime = -1
      this.onSeek()
    }
    this.video.addEventListener('loadedmetadata', this.loadedMetadataHandler)
    this.video.addEventListener('seeked', this.seekedHandler)
  }

  protected emitEvent(event: SubtitleRendererEvent): void {
    this.onEvent?.(event)
  }

  protected setParserMetadata(metadata: SubtitleParserMetadata | null): void {
    this.parserMetadata = metadata
    if (metadata) {
      this.emitEvent({ type: 'loaded', format: this.format, metadata })
    }
  }

  protected emitWorkerState(enabled: boolean, ready: boolean, sessionId: string | null, fallback = false): void {
    this.emitEvent({ type: 'worker-state', enabled, ready, sessionId, fallback })
  }

  protected emitCacheChange(cachedFrames: number, pendingRenders: number): void {
    this.emitEvent({ type: 'cache-change', cachedFrames, pendingRenders, cacheLimit: this.cacheLimit })
  }

  protected emitCueChange(cue: SubtitleCueMetadata | null): void {
    if (this.lastCueIndex === cue?.index && cue?.index !== undefined) {
      this.currentCueMetadata = cue
      return
    }

    this.lastCueIndex = cue?.index ?? null
    this.currentCueMetadata = cue
    this.emitEvent({ type: 'cue-change', cue })
  }

  protected emitRendererBackend(renderer: SubtitleRendererBackend): void {
    if (this.currentRendererBackend === renderer) return
    this.currentRendererBackend = renderer
    this.emitEvent({ type: 'renderer-change', renderer })
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
      this.emitRendererBackend('webgpu')
    } catch (error) {
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
      this.emitRendererBackend('webgl2')
    } catch (error) {
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
    this.emitRendererBackend('canvas2d')
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
  protected abstract buildCueMetadata(index: number): SubtitleCueMetadata | null

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
          this.emitCueChange(currentIndex >= 0 ? this.buildCueMetadata(currentIndex) : null)
          this.emitEvent({ type: 'stats', stats: this.getStats() })
          if (currentIndex >= 0 && (this.prefetchBefore > 0 || this.prefetchAfter > 0)) {
            const prefetch = (this as unknown as { prefetchAroundTime?: (time: number) => Promise<void> }).prefetchAroundTime
            prefetch?.call(this, currentTime).catch(() => {})
          }
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

  protected computeLayout(data: SubtitleData): {
    scaleX: number
    scaleY: number
    shiftX: number
    shiftY: number
    opacity: number
  } {
    if (!this.canvas) {
      return { scaleX: 1, scaleY: 1, shiftX: 0, shiftY: 0, opacity: this.displaySettings.opacity }
    }

    const baseScaleX = this.canvas.width / data.width
    const baseScaleY = this.canvas.height / data.height
    const bounds = getSubtitleBounds(data)
    const { scale, verticalOffset, horizontalOffset, horizontalAlign, bottomPadding, safeArea, opacity } =
      this.displaySettings

    if (!bounds) {
      return {
        scaleX: baseScaleX * scale,
        scaleY: baseScaleY * scale,
        shiftX: (horizontalOffset / 100) * this.canvas.width,
        shiftY: (verticalOffset / 100) * this.canvas.height - (bottomPadding / 100) * this.canvas.height,
        opacity
      }
    }

    const groupWidth = bounds.width * baseScaleX
    const groupHeight = bounds.height * baseScaleY
    const scaledGroupWidth = groupWidth * scale
    const scaledGroupHeight = groupHeight * scale

    let anchorShiftX = 0
    if (horizontalAlign === 'center') {
      anchorShiftX = (groupWidth - scaledGroupWidth) / 2
    } else if (horizontalAlign === 'right') {
      anchorShiftX = groupWidth - scaledGroupWidth
    }

    let shiftX = anchorShiftX + (horizontalOffset / 100) * this.canvas.width
    let shiftY = groupHeight - scaledGroupHeight + (verticalOffset / 100) * this.canvas.height
    shiftY -= (bottomPadding / 100) * this.canvas.height

    const safeX = (safeArea / 100) * this.canvas.width
    const safeY = (safeArea / 100) * this.canvas.height
    const finalMinX = bounds.x * baseScaleX + shiftX
    const finalMinY = bounds.y * baseScaleY + shiftY
    const finalMaxX = finalMinX + scaledGroupWidth
    const finalMaxY = finalMinY + scaledGroupHeight

    if (finalMinX < safeX) shiftX += safeX - finalMinX
    if (finalMaxX > this.canvas.width - safeX) shiftX -= finalMaxX - (this.canvas.width - safeX)
    if (finalMinY < safeY) shiftY += safeY - finalMinY
    if (finalMaxY > this.canvas.height - safeY) shiftY -= finalMaxY - (this.canvas.height - safeY)

    return {
      scaleX: baseScaleX * scale,
      scaleY: baseScaleY * scale,
      shiftX,
      shiftY,
      opacity
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
    const layout = this.computeLayout(data)

    this.webgpuRenderer.render(
      data.compositionData,
      data.width,
      data.height,
      layout.scaleX,
      layout.scaleY,
      layout.shiftX,
      layout.shiftY,
      layout.opacity
    )
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

    const layout = this.computeLayout(data)

    this.webgl2Renderer.render(
      data.compositionData,
      data.width,
      data.height,
      layout.scaleX,
      layout.scaleY,
      layout.shiftX,
      layout.shiftY,
      layout.opacity
    )
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

    const layout = this.computeLayout(data)

    this.ctx.save()
    this.ctx.globalAlpha = layout.opacity

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
      const scaledWidth = comp.pixelData.width * layout.scaleX
      const scaledHeight = comp.pixelData.height * layout.scaleY
      const adjustedX = comp.x * (this.canvas.width / data.width) + layout.shiftX
      const adjustedY = comp.y * (this.canvas.height / data.height) + layout.shiftY

      this.ctx.drawImage(this.tempCanvas, adjustedX, adjustedY, scaledWidth, scaledHeight)
    }

    this.ctx.restore()
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
    if (this.loadedMetadataHandler) {
      this.video.removeEventListener('loadedmetadata', this.loadedMetadataHandler)
      this.loadedMetadataHandler = null
    }
    if (this.seekedHandler) {
      this.video.removeEventListener('seeked', this.seekedHandler)
      this.seekedHandler = null
    }

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
    this.currentCueMetadata = null
    this.parserMetadata = null
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
    super(options, 'pgs')
    this.onLoading = options.onLoading
    this.onLoaded = options.onLoaded
    this.onError = options.onError
    applyCacheLimit(this.state, this.cacheLimit)
    this.startInit()
  }

  protected async loadSubtitles(): Promise<void> {
    try {
      this.emitEvent({ type: 'loading', format: 'pgs' })
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
          this.state.sessionId = createWorkerSessionId()
          await getOrCreateWorker()
          this.emitWorkerState(true, false, this.state.sessionId)
          const loadResponse = await sendToWorker({
            type: 'loadPgs',
            sessionId: this.state.sessionId,
            data: data.buffer.slice(0)
          })

          if (loadResponse.type === 'pgsLoaded') {
            this.state.workerReady = true
            this.state.metadata = loadResponse.metadata
            const tsResponse = await sendToWorker({ type: 'getPgsTimestamps', sessionId: this.state.sessionId })
            if (tsResponse.type === 'pgsTimestamps') {
              this.state.timestamps = tsResponse.timestamps
            }
            this.isLoaded = true
            this.setParserMetadata(loadResponse.metadata)
            this.emitWorkerState(true, true, this.state.sessionId)
            this.onLoaded?.()
            return // Success, don't fall through to main thread
          } else if (loadResponse.type === 'error') {
            throw new Error(loadResponse.message)
          }
        } catch (workerError) {
          this.state.useWorker = false
          this.emitWorkerState(false, false, this.state.sessionId, true)
        }
      }

      // Main thread fallback - use idle callback to avoid blocking UI
      await this.loadOnMainThread(data)
      this.onLoaded?.()
    } catch (error) {
      const resolvedError = error instanceof Error ? error : new Error(String(error))
      this.emitEvent({ type: 'error', format: 'pgs', error: resolvedError })
      this.onError?.(resolvedError)
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
        this.state.metadata = this.pgsParser!.getMetadata()
        this.isLoaded = true
        this.setParserMetadata(this.state.metadata)
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
    if (this.state.frameCache.has(index)) {
      return this.state.frameCache.get(index) ?? undefined
    }

    if (this.state.useWorker && this.state.workerReady) {
      if (!this.state.pendingRenders.has(index)) {
        const renderPromise = sendToWorker({
          type: 'renderPgsAtIndex',
          sessionId: this.state.sessionId!,
          index
        }).then((response) => (response.type === 'pgsFrame' && response.frame ? convertFrameData(response.frame) : null))

        this.state.pendingRenders.set(index, renderPromise)
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        renderPromise.then((result) => {
          setCachedFrame(this.state, index, result)
          this.state.pendingRenders.delete(index)
          this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
          // Force re-render on next frame by resetting lastRenderedIndex
          if (this.findCurrentIndex(this.video.currentTime) === index) {
            this.lastRenderedIndex = -1
          }
        })
      }
      // Return undefined to indicate async loading in progress
      return undefined
    }

    const rendered = this.pgsParser?.renderAtIndex(index) ?? null
    setCachedFrame(this.state, index, rendered)
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    return rendered ?? undefined
  }

  protected buildCueMetadata(index: number): SubtitleCueMetadata | null {
    if (this.pgsParser) {
      return this.pgsParser.getCueMetadata(index)
    }

    const metadata = this.state.metadata
    if (!metadata || index < 0 || index >= this.state.timestamps.length) return null

    const startTime = this.state.timestamps[index]
    const endTime = this.state.timestamps[index + 1] ?? startTime + 5000
    const frame = this.state.frameCache.get(index) ?? null

    return {
      index,
      format: 'pgs',
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      screenWidth: metadata.screenWidth,
      screenHeight: metadata.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : null,
      compositionCount: frame?.compositionData.length ?? 0
    }
  }

  protected isPendingRender(index: number): boolean {
    return this.state.pendingRenders.has(index)
  }

  protected onSeek(): void {
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearPgsCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.pgsParser?.clearCache()
  }

  setCacheLimit(limit: number): void {
    this.cacheLimit = applyCacheLimit(this.state, limit)
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  clearFrameCache(): void {
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    this.lastRenderedIndex = -1
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearPgsCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.pgsParser?.clearCache()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  async prefetchRange(startIndex: number, endIndex: number): Promise<void> {
    const safeStart = Math.max(0, Math.min(startIndex, endIndex))
    const safeEnd = Math.min(Math.max(startIndex, endIndex), this.state.timestamps.length - 1)

    for (let index = safeStart; index <= safeEnd; index++) {
      if (this.state.frameCache.has(index)) continue
      const result = this.renderAtIndex(index)
      if (result === undefined && this.state.pendingRenders.has(index)) {
        await this.state.pendingRenders.get(index)
      }
    }
  }

  async prefetchAroundTime(time: number, before = this.prefetchBefore, after = this.prefetchAfter): Promise<void> {
    const currentIndex = this.findCurrentIndex(time)
    if (currentIndex < 0) return
    await this.prefetchRange(currentIndex - before, currentIndex + after)
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
      sendToWorker({ type: 'disposePgs', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.pgsParser?.dispose()
    this.pgsParser = null
    this.state.sessionId = null
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
    super(options, 'vobsub')
    this.idxUrl = options.idxUrl || (options.subUrl ? options.subUrl.replace(/\\.sub$/i, '.idx') : undefined)
    this.idxContent = options.idxContent
    this.onLoading = options.onLoading
    this.onLoaded = options.onLoaded
    this.onError = options.onError
    applyCacheLimit(this.state, this.cacheLimit)
    this.startInit()
  }

  protected async loadSubtitles(): Promise<void> {
    try {
      this.emitEvent({ type: 'loading', format: 'vobsub' })
      this.onLoading?.()

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

      if (this.state.useWorker) {
        try {
          this.state.sessionId = createWorkerSessionId()
          await getOrCreateWorker()
          this.emitWorkerState(true, false, this.state.sessionId)
          const loadResponse = await sendToWorker({
            type: 'loadVobSub',
            sessionId: this.state.sessionId,
            idxContent: idxData,
            subData: subData.buffer.slice(0)
          })

          if (loadResponse.type === 'vobSubLoaded') {
            this.state.workerReady = true
            this.state.metadata = loadResponse.metadata
            const tsResponse = await sendToWorker({ type: 'getVobSubTimestamps', sessionId: this.state.sessionId })
            if (tsResponse.type === 'vobSubTimestamps') {
              this.state.timestamps = tsResponse.timestamps
            }
            this.isLoaded = true
            this.setParserMetadata(loadResponse.metadata)
            this.emitWorkerState(true, true, this.state.sessionId)
            this.onLoaded?.()
            return // Success, don't fall through to main thread
          } else if (loadResponse.type === 'error') {
            throw new Error(loadResponse.message)
          }
        } catch (workerError) {
          this.state.useWorker = false
          this.emitWorkerState(false, false, this.state.sessionId, true)
        }
      }

      // Main thread fallback
      await this.loadOnMainThread(idxData, subData)
      this.onLoaded?.()
    } catch (error) {
      const resolvedError = error instanceof Error ? error : new Error(String(error))
      this.emitEvent({ type: 'error', format: 'vobsub', error: resolvedError })
      this.onError?.(resolvedError)
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
        this.state.metadata = this.vobsubParser!.getMetadata()
        this.isLoaded = true
        this.setParserMetadata(this.state.metadata)
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
        this.pendingIndexLookup = sendToWorker({
          type: 'findVobSubIndex',
          sessionId: this.state.sessionId!,
          timeMs
        }).then((response) => {
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
    if (this.state.frameCache.has(index)) {
      return this.state.frameCache.get(index) ?? undefined
    }

    if (this.state.useWorker && this.state.workerReady) {
      // Start async render if not already pending
      if (!this.state.pendingRenders.has(index)) {
        const renderPromise = sendToWorker({
          type: 'renderVobSubAtIndex',
          sessionId: this.state.sessionId!,
          index
        }).then((response) => (response.type === 'vobSubFrame' && response.frame ? convertFrameData(response.frame) : null))

        this.state.pendingRenders.set(index, renderPromise)
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        renderPromise.then((result) => {
          setCachedFrame(this.state, index, result)
          this.state.pendingRenders.delete(index)
          this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
          // Force re-render on next frame by resetting lastRenderedIndex
          if (this.findCurrentIndex(this.video.currentTime) === index) {
            this.lastRenderedIndex = -1
          }
        })
      }
      // Return undefined to indicate async loading in progress
      return undefined
    }

    const rendered = this.vobsubParser?.renderAtIndex(index) ?? null
    setCachedFrame(this.state, index, rendered)
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    return rendered ?? undefined
  }

  protected buildCueMetadata(index: number): SubtitleCueMetadata | null {
    if (this.vobsubParser) {
      return this.vobsubParser.getCueMetadata(index)
    }

    const metadata = this.state.metadata
    if (!metadata || index < 0 || index >= this.state.timestamps.length) return null

    const startTime = this.state.timestamps[index]
    const endTime = this.state.timestamps[index + 1] ?? startTime + 5000
    const frame = this.state.frameCache.get(index) ?? null

    return {
      index,
      format: 'vobsub',
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      screenWidth: metadata.screenWidth,
      screenHeight: metadata.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : null,
      compositionCount: frame?.compositionData.length ?? 0,
      language: metadata.language ?? null,
      trackId: metadata.trackId ?? null
    }
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
      sendToWorker({ type: 'clearVobSubCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.vobsubParser?.clearCache()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  setCacheLimit(limit: number): void {
    this.cacheLimit = applyCacheLimit(this.state, limit)
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  clearFrameCache(): void {
    this.state.frameCache.clear()
    this.state.pendingRenders.clear()
    this.cachedIndex = -1
    this.cachedIndexTime = -1
    this.pendingIndexLookup = null
    this.lastRenderedIndex = -1
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearVobSubCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.vobsubParser?.clearCache()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  async prefetchRange(startIndex: number, endIndex: number): Promise<void> {
    const safeStart = Math.max(0, Math.min(startIndex, endIndex))
    const safeEnd = Math.min(Math.max(startIndex, endIndex), this.state.timestamps.length - 1)

    for (let index = safeStart; index <= safeEnd; index++) {
      if (this.state.frameCache.has(index)) continue
      const result = this.renderAtIndex(index)
      if (result === undefined && this.state.pendingRenders.has(index)) {
        await this.state.pendingRenders.get(index)
      }
    }
  }

  async prefetchAroundTime(time: number, before = this.prefetchBefore, after = this.prefetchAfter): Promise<void> {
    const currentIndex = this.findCurrentIndex(time)
    if (currentIndex < 0) return
    await this.prefetchRange(currentIndex - before, currentIndex + after)
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
      sendToWorker({ type: 'setVobSubDebandEnabled', sessionId: this.state.sessionId!, enabled }).catch(() => {})
    }
    this.vobsubParser?.setDebandEnabled(enabled)
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.lastRenderedIndex = -1
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  /** Set debanding threshold (0-255, default: 64) */
  setDebandThreshold(threshold: number): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandThreshold', sessionId: this.state.sessionId!, threshold }).catch(() => {})
    }
    this.vobsubParser?.setDebandThreshold(threshold)
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.lastRenderedIndex = -1
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  /** Set debanding sample range in pixels (1-64, default: 15) */
  setDebandRange(range: number): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandRange', sessionId: this.state.sessionId!, range }).catch(() => {})
    }
    this.vobsubParser?.setDebandRange(range)
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.lastRenderedIndex = -1
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
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
      sendToWorker({ type: 'disposeVobSub', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.vobsubParser?.dispose()
    this.vobsubParser = null
    this.state.sessionId = null
  }
}

/** Create a video subtitle renderer with automatic format detection. */
export function createAutoSubtitleRenderer(options: AutoVideoSubtitleOptions): PgsRenderer | VobSubRenderer {
  const format = detectSubtitleFormat({
    data: options.subContent,
    idxContent: options.idxContent,
    fileName: options.fileName,
    subUrl: options.subUrl,
    idxUrl: options.idxUrl
  })

  if (format === 'pgs') {
    return new PgsRenderer(options)
  }

  if (format === 'vobsub') {
    return new VobSubRenderer(options)
  }

  throw new Error('Unable to detect subtitle format for video renderer')
}
