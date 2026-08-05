/**
 * High-level video-integrated subtitle renderers for libbitsub.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */

import type {
  AssetFetchStrategy,
  AutoVideoSubtitleOptions,
  SubtitleCacheStats,
  SubtitleCueBounds,
  SubtitleCueMetadata,
  SubtitleData,
  SubtitleDiagnosticWarning,
  SubtitleDisplaySettings,
  SubtitleLastRenderInfo,
  SubtitleParserMetadata,
  SubtitleRendererBackend,
  SubtitleRendererEvent,
  SubtitleSynchronizationMode,
  VideoSubtitleOptions,
  VideoVobSubOptions,
  WorkerRendererState
} from './types'
import {
  SubtitleDiagnosticError,
  createSubtitleDiagnosticError,
  createSubtitleWarning,
  formatSubtitleWarningForConsole,
  normalizeSubtitleError,
  warningFromRenderIssue
} from './diagnostics'
import { fetchSubtitleAsset, fetchSubtitleText, type AssetFetchProgress } from './range-loader'
import { initWasm } from './wasm'
import { getOrCreateWorker, sendToWorker } from './worker'
import { canUseWorkerOffscreenRender } from './capabilities'
import {
  binarySearchTimestamp,
  convertFrameData,
  createWorkerSessionId,
  createWorkerState,
  detectSubtitleFormat,
  getSubtitleBounds,
  isMksSource,
  setCacheLimit as applyCacheLimit,
  setCachedFrame
} from './utils'
import { PgsParser, DvbParser, VobSubParserLowLevel } from './parsers'
import { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer'
import { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'
import { VideoFrameScheduler, supportsFrameAwareSync, type VideoFrameTick } from './video-frame-scheduler'

/** Default display settings */
const DEFAULT_DISPLAY_SETTINGS: SubtitleDisplaySettings = {
  scale: 1.0,
  aspectMode: 'stretch',
  verticalOffset: 0,
  horizontalOffset: 0,
  horizontalAlign: 'center',
  bottomPadding: 0,
  safeArea: 0,
  opacity: 1.0
}

interface SubtitleRenderLayout {
  scaleX: number
  scaleY: number
  shiftX: number
  shiftY: number
  opacity: number
}

interface RenderFrameOutcome {
  status: 'rendered' | 'cleared' | 'pending' | 'empty' | 'failed'
  data: SubtitleData | null
  warning: SubtitleDiagnosticWarning | null
}

interface OffscreenFrameMetadata {
  width: number | null
  height: number | null
  bounds: SubtitleCueBounds | null
  compositionCount: number
}

function createTransferableBuffer(data: Uint8Array, preserveSource: boolean): ArrayBuffer {
  if (
    !preserveSource &&
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer
  }

  return data.slice().buffer
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
  /** Active video synchronization clock */
  syncMode: SubtitleSynchronizationMode
}

/**
 * Base class for video-integrated subtitle renderers.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */
abstract class BaseVideoSubtitleRenderer {
  protected video: HTMLVideoElement
  protected readonly format: 'pgs' | 'vobsub' | 'dvb'
  protected subUrl?: string
  protected subContent?: ArrayBuffer
  protected canvas: HTMLCanvasElement | null = null
  protected ctx: CanvasRenderingContext2D | null = null
  private frameScheduler: VideoFrameScheduler | null = null
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
  private _timeOffset: number = 0
  protected cacheLimit: number = 24
  protected prefetchBefore: number = 0
  protected prefetchAfter: number = 0
  protected streamingLoad: boolean = true
  protected rangeRequests: boolean = true
  protected onEvent?: (event: SubtitleRendererEvent) => void
  protected onWarning?: (warning: SubtitleDiagnosticWarning) => void
  protected currentRendererBackend: SubtitleRendererBackend | null = null
  protected readonly debug: boolean
  protected lastRenderInfo: SubtitleLastRenderInfo | null = null

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

  protected readonly offscreenRenderOption: boolean
  protected readonly frameAwareSync: boolean
  protected pendingWorkerOffscreen = false
  protected useWorkerOffscreen = false
  protected canvasPixelWidth = 1
  protected canvasPixelHeight = 1
  private presentationToken = 0
  private offscreenAttachPromise: Promise<void> | null = null
  private offscreenTransferPending = false
  private offscreenFrameMetadata = new Map<number, OffscreenFrameMetadata>()
  private lastSynchronizedTime: number | null = null
  private lastPresentedFrames: number | null = null

  // Performance tracking
  protected perfStats = {
    framesRendered: 0,
    framesDropped: 0,
    renderTimes: [] as number[],
    lastRenderTime: 0,
    fpsTimestamps: [] as number[],
    lastFrameTime: 0
  }

  constructor(options: VideoSubtitleOptions, format: 'pgs' | 'vobsub' | 'dvb') {
    this.video = options.video
    this.format = format
    this.subUrl = options.subUrl
    this.subContent = options.subContent
    this.onWebGPUFallback = options.onWebGPUFallback
    this.onWebGL2Fallback = options.onWebGL2Fallback
    this.offscreenRenderOption = options.offscreenRender !== false
    this.frameAwareSync = options.frameAwareSync !== false
    this.onEvent = options.onEvent
    this.onWarning = options.onWarning
    this.debug = Boolean(options.debug)
    this.displaySettings = { ...DEFAULT_DISPLAY_SETTINGS, ...options.displaySettings }
    this.timeOffset = options.timeOffset ?? 0
    this.cacheLimit = Math.max(0, Math.floor(options.cacheLimit ?? 24))
    this.prefetchBefore = Math.max(0, Math.floor(options.prefetchWindow?.before ?? 0))
    this.prefetchAfter = Math.max(0, Math.floor(options.prefetchWindow?.after ?? 0))
    this.streamingLoad = options.streamingLoad !== false
    this.rangeRequests = options.rangeRequests !== false
  }

  protected emitLoadProgress(
    format: 'pgs' | 'vobsub' | 'dvb',
    progress: AssetFetchProgress,
    indexedCues: number
  ): void {
    this.emitEvent({
      type: 'load-progress',
      format,
      loadedBytes: progress.loaded,
      totalBytes: progress.total,
      ratio: progress.ratio,
      strategy: progress.strategy,
      rangeSupported: progress.rangeSupported,
      indexedCues
    })
  }

  protected emitIndexed(format: 'pgs' | 'vobsub' | 'dvb', metadata: SubtitleParserMetadata, partial: boolean): void {
    this.emitEvent({ type: 'indexed', format, metadata, partial })
  }

  protected memoryProgress(byteLength: number): AssetFetchProgress {
    return {
      loaded: byteLength,
      total: byteLength,
      ratio: 1,
      rangeSupported: false,
      strategy: 'memory'
    }
  }

  /** Get current display settings */
  getDisplaySettings(): SubtitleDisplaySettings {
    return { ...this.displaySettings }
  }

  /** Time offset in seconds added to the active video clock for subtitle lookup. */
  get timeOffset(): number {
    return this._timeOffset
  }

  set timeOffset(value: number) {
    if (value === this._timeOffset) return
    this._timeOffset = value
    this.invalidatePresentation()
    this.lastSynchronizedTime = null
    this.lastRenderedIndex = -1
    this.lastRenderedTime = -1
    this.renderPausedFrame()
  }

  /** Get performance statistics */
  abstract getStats(): SubtitleRendererStats

  /** Get cache-related diagnostics for the active renderer session. */
  getCacheStats(): SubtitleCacheStats {
    const state = this.getWorkerRendererState()

    return {
      cacheLimit: this.cacheLimit,
      cachedFrames: state.frameCache.size,
      pendingRenders: state.pendingRenders.size,
      totalEntries: state.timestamps.length,
      usingWorker: state.useWorker && state.workerReady,
      workerReady: state.workerReady,
      sessionId: state.sessionId
    }
  }

  /** Get the most recent render attempt when debug mode is enabled. */
  getLastRenderInfo(): SubtitleLastRenderInfo | null {
    if (!this.lastRenderInfo) return null

    return {
      ...this.lastRenderInfo,
      cache: { ...this.lastRenderInfo.cache },
      cue: this.lastRenderInfo.cue ? { ...this.lastRenderInfo.cue } : null
    }
  }

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
      currentIndex: this.lastRenderedIndex,
      syncMode: this.getSynchronizationMode()
    }
  }

  /** Get the active video synchronization clock. */
  getSynchronizationMode(): SubtitleSynchronizationMode {
    if (this.frameScheduler) return this.frameScheduler.mode
    return supportsFrameAwareSync(this.video, this.frameAwareSync) ? 'video-frame' : 'animation-frame'
  }

  /** Set display settings and force re-render */
  setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void {
    const nextSettings = {
      ...this.displaySettings,
      ...settings
    }

    nextSettings.scale = Math.max(0.1, Math.min(3.0, nextSettings.scale))
    if (!['stretch', 'contain', 'cover'].includes(nextSettings.aspectMode)) {
      nextSettings.aspectMode = DEFAULT_DISPLAY_SETTINGS.aspectMode
    }
    nextSettings.verticalOffset = Math.max(-50, Math.min(50, nextSettings.verticalOffset))
    nextSettings.horizontalOffset = Math.max(-50, Math.min(50, nextSettings.horizontalOffset))
    nextSettings.bottomPadding = Math.max(0, Math.min(50, nextSettings.bottomPadding))
    nextSettings.safeArea = Math.max(0, Math.min(25, nextSettings.safeArea))
    nextSettings.opacity = Math.max(0, Math.min(1, nextSettings.opacity))

    const changed = JSON.stringify(nextSettings) !== JSON.stringify(this.displaySettings)
    this.displaySettings = nextSettings

    // Force re-render if settings changed
    if (changed) {
      this.invalidatePresentation()
      this.lastRenderedIndex = -1
      this.lastRenderedTime = -1
      this.renderPausedFrame()
    }
  }

  /** Reset display settings to defaults */
  resetDisplaySettings(): void {
    this.displaySettings = { ...DEFAULT_DISPLAY_SETTINGS }
    this.invalidatePresentation()
    this.lastRenderedIndex = -1
    this.lastRenderedTime = -1
    this.renderPausedFrame()
  }

  /** Start initialization. */
  protected startInit(): void {
    this.init().catch((error) => {
      this.emitEvent({
        type: 'error',
        format: this.format,
        error: normalizeSubtitleError(error, { format: this.format })
      })
    })
  }

  /** Initialize the renderer. */
  protected async init(): Promise<void> {
    await initWasm()
    this.createCanvas()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await this.loadSubtitles()
    await this.ensureWorkerOffscreenAttached()
    this.startRenderLoop()
  }

  protected shouldPreferWorkerOffscreen(): boolean {
    return this.offscreenRenderOption && canUseWorkerOffscreenRender()
  }

  protected isWorkerOffscreenPresent(): boolean {
    return this.useWorkerOffscreen
  }

  private mountOverlayCanvas(canvas: HTMLCanvasElement): void {
    Object.assign(canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '10'
    })

    const parent = this.video.parentElement
    if (parent) {
      if (window.getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative'
      }
      parent.appendChild(canvas)
    }
  }

  /** Create the canvas overlay positioned over the video. */
  protected createCanvas(): void {
    this.canvas = document.createElement('canvas')
    this.mountOverlayCanvas(this.canvas)

    if (isWebGPUSupported()) {
      this.initWebGPU()
    } else if (isWebGL2Supported()) {
      this.initWebGL2()
    } else if (this.shouldPreferWorkerOffscreen()) {
      this.pendingWorkerOffscreen = true
    } else {
      this.initCanvas2D()
    }

    this.updateCanvasSize()

    this.resizeObserver = new ResizeObserver(() => this.updateCanvasSize())
    this.resizeObserver.observe(this.video)
    this.loadedMetadataHandler = () => this.updateCanvasSize()
    this.seekedHandler = () => {
      this.invalidatePresentation()
      this.lastRenderedIndex = -1
      this.lastRenderedTime = -1
      this.lastSynchronizedTime = null
      this.offscreenFrameMetadata.clear()
      this.onSeek()
      this.renderPausedFrame()
    }
    this.video.addEventListener('loadedmetadata', this.loadedMetadataHandler)
    this.video.addEventListener('seeked', this.seekedHandler)
  }

  private preferWorkerOffscreenOrCanvas2D(): void {
    if (this.shouldPreferWorkerOffscreen()) {
      this.pendingWorkerOffscreen = true
      const state = this.getWorkerRendererState()
      if (state.useWorker && state.workerReady && state.sessionId) {
        void this.ensureWorkerOffscreenAttached()
      }
      return
    }
    this.initCanvas2D()
  }

  protected ensureWorkerOffscreenAttached(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.offscreenAttachPromise) return this.offscreenAttachPromise
    if (!this.pendingWorkerOffscreen || !this.canvas) return Promise.resolve()

    const state = this.getWorkerRendererState()
    if (!state.useWorker || !state.workerReady || !state.sessionId) {
      this.pendingWorkerOffscreen = false
      this.initCanvas2D()
      this.updateCanvasSize()
      return Promise.resolve()
    }

    const sessionId = state.sessionId
    this.pendingWorkerOffscreen = false
    this.offscreenTransferPending = true

    let attachPromise: Promise<void>
    attachPromise = this.attachWorkerOffscreen(sessionId).finally(() => {
      this.offscreenTransferPending = false
      if (this.offscreenAttachPromise === attachPromise) {
        this.offscreenAttachPromise = null
      }
    })
    this.offscreenAttachPromise = attachPromise
    return attachPromise
  }

  private async attachWorkerOffscreen(sessionId: string): Promise<void> {
    try {
      const transferableCanvas = this.canvas as HTMLCanvasElement & {
        transferControlToOffscreen: () => OffscreenCanvas
      }
      const offscreen = transferableCanvas.transferControlToOffscreen()
      const attachResponse = await sendToWorker({
        type: 'attachOffscreenCanvas',
        sessionId,
        canvas: offscreen
      })
      if (attachResponse.type === 'error') {
        throw new Error(attachResponse.message)
      }
      if (attachResponse.type !== 'offscreenAttached') {
        throw new Error('Worker OffscreenCanvas attach failed')
      }
      if (this.disposed) {
        await sendToWorker({ type: 'detachOffscreenCanvas', sessionId })
        return
      }

      this.useWorkerOffscreen = true
      this.emitRendererBackend('worker-offscreen')
      this.lastRenderedIndex = -1
      this.lastRenderedTime = -1

      await sendToWorker({
        type: 'resizeOffscreenCanvas',
        sessionId,
        width: this.canvasPixelWidth,
        height: this.canvasPixelHeight
      })
    } catch (error) {
      this.offscreenTransferPending = false
      this.useWorkerOffscreen = false
      if (this.disposed) return
      this.recreateCanvasForMainThreadFallback()
      this.emitWarning(
        createSubtitleWarning(
          'WORKER_FALLBACK',
          'Worker OffscreenCanvas present unavailable; falling back to main-thread Canvas2D.',
          {
            format: this.format,
            details: { reason: error instanceof Error ? error.message : String(error) }
          }
        )
      )
    }
  }

  private recreateCanvasForMainThreadFallback(): void {
    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas)
    }
    this.canvas = document.createElement('canvas')
    this.mountOverlayCanvas(this.canvas)
    this.initCanvas2D()
    this.updateCanvasSize()
    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement('canvas')
      this.tempCtx = this.tempCanvas.getContext('2d')
    }
  }

  private fallbackFromWorkerOffscreen(reason: string): void {
    if (!this.useWorkerOffscreen || this.disposed) return

    const state = this.getWorkerRendererState()
    this.invalidatePresentation()
    this.useWorkerOffscreen = false
    this.pendingWorkerOffscreen = false
    this.offscreenFrameMetadata.clear()
    if (state.sessionId) {
      sendToWorker({ type: 'detachOffscreenCanvas', sessionId: state.sessionId }).catch(() => {})
    }
    this.recreateCanvasForMainThreadFallback()
    this.lastRenderedIndex = -2
    this.lastRenderedTime = -1
    this.emitWarning(
      createSubtitleWarning(
        'WORKER_FALLBACK',
        'Worker OffscreenCanvas present failed; falling back to main-thread Canvas2D.',
        {
          format: this.format,
          details: { reason }
        }
      )
    )
  }

  protected getOffscreenFrameMetadata(index: number): OffscreenFrameMetadata | null {
    return this.offscreenFrameMetadata.get(index) ?? null
  }

  protected clearOffscreenFrameMetadata(): void {
    this.offscreenFrameMetadata.clear()
  }

  protected emitEvent(event: SubtitleRendererEvent): void {
    this.onEvent?.(event)
  }

  protected emitWarning(warning: SubtitleDiagnosticWarning): void {
    this.onWarning?.(warning)
    this.emitEvent({ type: 'warning', warning })

    if (this.debug && !this.onWarning) {
      console.warn(formatSubtitleWarningForConsole(warning), warning.details ?? {})
    }
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

  protected recordLastRenderInfo(info: SubtitleLastRenderInfo): void {
    if (!this.debug) return
    this.lastRenderInfo = info
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
      if (isWebGL2Supported()) {
        this.initWebGL2()
      } else {
        this.preferWorkerOffscreenOrCanvas2D()
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
      this.preferWorkerOffscreenOrCanvas2D()
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
    this.canvasPixelWidth = pixelWidth
    this.canvasPixelHeight = pixelHeight

    // Position canvas to match video content area
    this.canvas.style.left = `${bounds.x}px`
    this.canvas.style.top = `${bounds.y}px`
    this.canvas.style.width = `${bounds.width}px`
    this.canvas.style.height = `${bounds.height}px`

    if (this.useWorkerOffscreen || this.pendingWorkerOffscreen || this.offscreenTransferPending) {
      const state = this.getWorkerRendererState()
      if (this.useWorkerOffscreen && state.sessionId && state.workerReady) {
        sendToWorker({
          type: 'resizeOffscreenCanvas',
          sessionId: state.sessionId,
          width: pixelWidth,
          height: pixelHeight
        }).catch(() => {})
      }
    } else {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight

      // Update GPU renderer size if active
      if (this.useWebGPU && this.webgpuRenderer) {
        this.webgpuRenderer.updateSize(pixelWidth, pixelHeight)
      } else if (this.useWebGL2 && this.webgl2Renderer) {
        this.webgl2Renderer.updateSize(pixelWidth, pixelHeight)
      }
    }

    this.lastRenderedIndex = -1
    this.lastRenderedTime = -1
    this.invalidatePresentation()
    if (this.frameScheduler) {
      this.renderPausedFrame()
    }
  }

  protected abstract loadSubtitles(): Promise<void>
  protected abstract renderAtTime(time: number): SubtitleData | undefined
  protected abstract findCurrentIndex(time: number): number
  protected abstract renderAtIndex(index: number): SubtitleData | undefined
  protected abstract buildCueMetadata(index: number): SubtitleCueMetadata | null
  protected abstract getWorkerRendererState(): WorkerRendererState

  /** Check if a render is pending for the given index (async loading in progress) */
  protected abstract isPendingRender(index: number): boolean

  /** Start the render loop. */
  protected startRenderLoop(): void {
    if (!this.useWorkerOffscreen) {
      this.tempCanvas = document.createElement('canvas')
      this.tempCtx = this.tempCanvas.getContext('2d')
    }

    this.frameScheduler = new VideoFrameScheduler(this.video, this.frameAwareSync, (tick) =>
      this.renderSynchronizedFrame(tick)
    )
    this.renderPausedFrame()
    this.frameScheduler.start()
  }

  protected renderPausedFrame(): void {
    if (!this.video.paused && !this.video.ended) return
    this.renderSynchronizedFrame({ mediaTime: this.video.currentTime, presentedFrames: null })
  }

  private renderSynchronizedFrame(tick: VideoFrameTick): void {
    if (this.disposed || !this.isLoaded) return

    const currentTime = tick.mediaTime + this.timeOffset
    this.lastSynchronizedTime = currentTime
    if (tick.presentedFrames !== null) {
      if (this.lastPresentedFrames !== null && tick.presentedFrames > this.lastPresentedFrames + 1) {
        this.perfStats.framesDropped += tick.presentedFrames - this.lastPresentedFrames - 1
      }
      this.lastPresentedFrames = tick.presentedFrames
    }

    const currentIndex = this.findCurrentIndex(currentTime)
    if (currentIndex === this.lastRenderedIndex) return

    const cacheHit =
      !this.useWorkerOffscreen && currentIndex >= 0 && this.getWorkerRendererState().frameCache.has(currentIndex)
    const workerOffscreenPresent = this.useWorkerOffscreen
    const startTime = performance.now()
    this.presentationToken++
    const outcome = this.renderFrame(currentTime, currentIndex)
    const endTime = performance.now()

    this.lastRenderedIndex = currentIndex
    this.lastRenderedTime = currentTime

    // Worker OffscreenCanvas presentation completes asynchronously. Its
    // callback records the real status, metadata, and render duration.
    if (workerOffscreenPresent) return

    const renderTime = endTime - startTime
    this.recordRenderPerformance(renderTime, endTime)

    if (outcome.warning) {
      this.emitWarning(outcome.warning)
    }

    const cue = currentIndex >= 0 ? this.buildCueMetadata(currentIndex) : null
    this.emitCueChange(cue)
    this.recordLastRenderInfo({
      time: currentTime,
      index: currentIndex,
      status: outcome.status,
      backend: this.currentRendererBackend,
      usingWorker: this.getCacheStats().usingWorker,
      cacheHit,
      renderDuration: Math.round(renderTime * 100) / 100,
      frameWidth: outcome.data?.width ?? null,
      frameHeight: outcome.data?.height ?? null,
      compositionCount: outcome.data?.compositionData.length ?? 0,
      cue,
      cache: this.getCacheStats(),
      capturedAt: endTime
    })
    this.emitEvent({ type: 'stats', stats: this.getStats() })
    if (currentIndex >= 0 && (this.prefetchBefore > 0 || this.prefetchAfter > 0)) {
      const prefetch = (this as unknown as { prefetchAroundTime?: (time: number) => Promise<void> }).prefetchAroundTime
      prefetch?.call(this, currentTime).catch(() => {})
    }
  }

  protected getCurrentSynchronizationTime(): number {
    return this.lastSynchronizedTime ?? this.video.currentTime + this.timeOffset
  }

  protected getPresentationToken(): number {
    return this.presentationToken
  }

  protected isCurrentPresentation(token: number): boolean {
    return !this.disposed && token === this.presentationToken
  }

  protected invalidatePresentation(): void {
    this.presentationToken++
  }

  protected watchPendingRender(index: number, pending: Promise<SubtitleData | null>): void {
    const token = this.getPresentationToken()
    void pending.then(
      () => {
        if (!this.isCurrentPresentation(token)) return
        if (this.findCurrentIndex(this.getCurrentSynchronizationTime()) !== index) return
        this.lastRenderedIndex = -1
        this.renderPausedFrame()
      },
      () => {}
    )
  }

  private recordRenderPerformance(renderTime: number, capturedAt: number, countAsDropped = true): void {
    this.perfStats.lastRenderTime = renderTime
    this.perfStats.renderTimes.push(renderTime)
    if (this.perfStats.renderTimes.length > 60) {
      this.perfStats.renderTimes.shift()
    }
    this.perfStats.framesRendered++
    this.perfStats.fpsTimestamps.push(capturedAt)
    if (countAsDropped && renderTime > 16.67) {
      this.perfStats.framesDropped++
    }
  }

  private recordOffscreenRenderCompletion(
    time: number,
    index: number,
    status: RenderFrameOutcome['status'],
    width: number | null,
    height: number | null,
    compositionCount: number,
    startedAt: number
  ): void {
    const completedAt = performance.now()
    const renderTime = completedAt - startedAt
    this.recordRenderPerformance(renderTime, completedAt, false)
    const cue = index >= 0 ? this.buildCueMetadata(index) : null
    this.emitCueChange(cue)
    this.recordLastRenderInfo({
      time,
      index,
      status,
      backend: this.currentRendererBackend,
      usingWorker: this.getCacheStats().usingWorker,
      cacheHit: false,
      renderDuration: Math.round(renderTime * 100) / 100,
      frameWidth: width,
      frameHeight: height,
      compositionCount,
      cue,
      cache: this.getCacheStats(),
      capturedAt: completedAt
    })
    this.emitEvent({ type: 'stats', stats: this.getStats() })
  }

  /** Render a subtitle frame to the canvas. */
  protected renderFrame(time: number, index: number): RenderFrameOutcome {
    if (!this.canvas) {
      return { status: 'failed', data: null, warning: null }
    }

    if (this.useWorkerOffscreen) {
      return this.renderFrameWorkerOffscreen(time, index)
    }

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
        return { status: 'pending', data: null, warning: null }
      }
    }

    const renderIssue = index >= 0 ? (this.getWorkerRendererState().renderIssues.get(index) ?? null) : null
    const warning = warningFromRenderIssue(renderIssue, { format: this.format, cueIndex: index })

    // Use best available renderer
    if (this.useWebGPU && this.webgpuRenderer) {
      this.renderFrameWebGPU(data, index)
    } else if (this.useWebGL2 && this.webgl2Renderer) {
      this.renderFrameWebGL2(data, index)
    } else {
      this.renderFrameCanvas2D(data, index)
    }

    if (index < 0) {
      return { status: 'cleared', data: null, warning: null }
    }

    if (warning) {
      return { status: 'failed', data: data ?? null, warning }
    }

    if (!data || data.compositionData.length === 0) {
      return { status: 'empty', data: data ?? null, warning: null }
    }

    return { status: 'rendered', data, warning: null }
  }

  private renderFrameWorkerOffscreen(time: number, index: number): RenderFrameOutcome {
    const state = this.getWorkerRendererState()
    if (!state.sessionId || !state.workerReady) {
      queueMicrotask(() => this.fallbackFromWorkerOffscreen('Worker session is not ready.'))
      return { status: 'pending', data: null, warning: null }
    }

    const token = this.getPresentationToken()
    const sessionId = state.sessionId
    const startedAt = performance.now()

    void sendToWorker({
      type: 'presentOffscreen',
      sessionId,
      format: this.format,
      index,
      canvasWidth: this.canvasPixelWidth,
      canvasHeight: this.canvasPixelHeight,
      displaySettings: { ...this.displaySettings }
    })
      .then((response) => {
        if (!this.isCurrentPresentation(token)) return
        if (response.type === 'error') {
          this.recordOffscreenRenderCompletion(time, index, 'failed', null, null, 0, startedAt)
          this.fallbackFromWorkerOffscreen(response.message)
          return
        }
        if (response.type !== 'offscreenPresented') {
          this.recordOffscreenRenderCompletion(time, index, 'failed', null, null, 0, startedAt)
          this.fallbackFromWorkerOffscreen(`Unexpected worker response: ${response.type}`)
          return
        }
        if (response.status === 'failed') {
          const warning = warningFromRenderIssue(response.renderIssue?.trim() || null, {
            format: this.format,
            cueIndex: index
          })
          if (warning) {
            this.emitWarning(warning)
          }
          this.recordOffscreenRenderCompletion(
            time,
            index,
            'failed',
            response.width ?? null,
            response.height ?? null,
            response.compositionCount ?? 0,
            startedAt
          )
          if (response.fatal) {
            this.fallbackFromWorkerOffscreen(response.renderIssue || 'Offscreen presentation failed.')
          }
          return
        }

        if (response.status === 'cleared' || response.status === 'empty' || response.compositionCount === 0) {
          this.lastRenderedData = null
        }

        if (index >= 0) {
          this.offscreenFrameMetadata.set(index, {
            width: response.width ?? null,
            height: response.height ?? null,
            bounds: response.bounds ?? null,
            compositionCount: response.compositionCount ?? 0
          })
        }

        const warning = warningFromRenderIssue(response.renderIssue?.trim() || null, {
          format: this.format,
          cueIndex: index
        })
        if (warning) {
          this.emitWarning(warning)
        }

        this.recordOffscreenRenderCompletion(
          time,
          index,
          response.status,
          response.width ?? null,
          response.height ?? null,
          response.compositionCount ?? 0,
          startedAt
        )
      })
      .catch((error) => {
        if (!this.isCurrentPresentation(token)) return
        this.recordOffscreenRenderCompletion(time, index, 'failed', null, null, 0, startedAt)
        this.fallbackFromWorkerOffscreen(error instanceof Error ? error.message : String(error))
      })

    if (index < 0) {
      this.lastRenderedData = null
      return { status: 'cleared', data: null, warning: null }
    }

    return { status: 'pending', data: null, warning: null }
  }

  protected computeLayout(data: SubtitleData): SubtitleRenderLayout {
    if (!this.canvas) {
      return { scaleX: 1, scaleY: 1, shiftX: 0, shiftY: 0, opacity: this.displaySettings.opacity }
    }

    const safeDataWidth = data.width > 0 ? data.width : this.canvas.width
    const safeDataHeight = data.height > 0 ? data.height : this.canvas.height
    const stretchScaleX = this.canvas.width / safeDataWidth
    const stretchScaleY = this.canvas.height / safeDataHeight
    const bounds =
      getSubtitleBounds(data) ??
      ({
        x: 0,
        y: 0,
        width: safeDataWidth,
        height: safeDataHeight
      } as const)
    const { scale, aspectMode, verticalOffset, horizontalOffset, horizontalAlign, bottomPadding, safeArea, opacity } =
      this.displaySettings

    let baseScaleX = stretchScaleX
    let baseScaleY = stretchScaleY
    let frameShiftX = 0
    let frameShiftY = 0

    if (aspectMode !== 'stretch') {
      const uniformScale =
        aspectMode === 'cover' ? Math.max(stretchScaleX, stretchScaleY) : Math.min(stretchScaleX, stretchScaleY)

      baseScaleX = uniformScale
      baseScaleY = uniformScale
      frameShiftX = (this.canvas.width - safeDataWidth * uniformScale) / 2
      frameShiftY = (this.canvas.height - safeDataHeight * uniformScale) / 2
    }

    const anchorX =
      horizontalAlign === 'left'
        ? bounds.x
        : horizontalAlign === 'right'
          ? bounds.x + bounds.width
          : bounds.x + bounds.width / 2
    const anchorY = bounds.y + bounds.height

    const scaleX = baseScaleX * scale
    const scaleY = baseScaleY * scale
    const anchorShiftX = frameShiftX + anchorX * baseScaleX * (1 - scale)
    const anchorShiftY = frameShiftY + anchorY * baseScaleY * (1 - scale)

    let shiftX = anchorShiftX + (horizontalOffset / 100) * this.canvas.width
    let shiftY = anchorShiftY + (verticalOffset / 100) * this.canvas.height
    shiftY -= (bottomPadding / 100) * this.canvas.height

    const safeX = (safeArea / 100) * this.canvas.width
    const safeY = (safeArea / 100) * this.canvas.height
    const finalMinX = bounds.x * scaleX + shiftX
    const finalMinY = bounds.y * scaleY + shiftY
    const finalMaxX = (bounds.x + bounds.width) * scaleX + shiftX
    const finalMaxY = (bounds.y + bounds.height) * scaleY + shiftY

    if (finalMinX < safeX) shiftX += safeX - finalMinX
    if (finalMaxX > this.canvas.width - safeX) shiftX -= finalMaxX - (this.canvas.width - safeX)
    if (finalMinY < safeY) shiftY += safeY - finalMinY
    if (finalMaxY > this.canvas.height - safeY) shiftY -= finalMaxY - (this.canvas.height - safeY)

    return {
      scaleX,
      scaleY,
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
      const adjustedX = comp.x * layout.scaleX + layout.shiftX
      const adjustedY = comp.y * layout.scaleY + layout.shiftY

      this.ctx.drawImage(this.tempCanvas, adjustedX, adjustedY, scaledWidth, scaledHeight)
    }

    this.ctx.restore()
  }

  /** Dispose of all resources. */
  dispose(): void {
    this.disposed = true
    this.invalidatePresentation()

    this.frameScheduler?.stop()
    this.frameScheduler = null

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

    const state = this.getWorkerRendererState()
    if (this.useWorkerOffscreen && state.sessionId) {
      sendToWorker({ type: 'detachOffscreenCanvas', sessionId: state.sessionId }).catch(() => {})
    }

    this.canvas?.parentElement?.removeChild(this.canvas)
    this.canvas = null
    this.ctx = null
    this.tempCanvas = null
    this.tempCtx = null
    this.lastRenderedData = null
    this.currentCueMetadata = null
    this.parserMetadata = null
    this.lastRenderInfo = null
    this.offscreenFrameMetadata.clear()
    this.useWebGPU = false
    this.useWebGL2 = false
    this.useWorkerOffscreen = false
    this.pendingWorkerOffscreen = false
    this.offscreenTransferPending = false
    this.offscreenAttachPromise = null
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

      if (this.subContent) {
        const data = new Uint8Array(this.subContent)
        this.emitLoadProgress('pgs', this.memoryProgress(data.byteLength), 0)
        await this.loadPgsBuffer(data, true)
        this.onLoaded?.()
        return
      }

      if (!this.subUrl) {
        throw new Error('No subtitle content or URL provided')
      }

      if (!this.streamingLoad) {
        const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(this.subUrl, {
          preferRange: this.rangeRequests,
          onProgress: (progress) => this.emitLoadProgress('pgs', progress, this.state.timestamps.length)
        })
        this.emitLoadProgress(
          'pgs',
          { loaded: data.byteLength, total: total ?? data.byteLength, ratio: 1, rangeSupported, strategy },
          0
        )
        await this.loadPgsBuffer(data, false)
        this.onLoaded?.()
        return
      }

      await this.loadPgsStreaming(this.subUrl)
      this.onLoaded?.()
    } catch (error) {
      const resolvedError = normalizeSubtitleError(error, { format: 'pgs' })
      this.emitEvent({ type: 'error', format: 'pgs', error: resolvedError })
      this.onError?.(resolvedError)
    }
  }

  private applyPgsIndexState(
    metadata: SubtitleParserMetadata,
    timestamps: Float64Array,
    partial: boolean,
    usingWorker: boolean
  ): void {
    this.state.metadata = metadata
    this.state.timestamps = timestamps
    this.setParserMetadata(metadata)
    this.emitIndexed('pgs', metadata, partial)
    if (!this.isLoaded && timestamps.length > 0) {
      this.isLoaded = true
      if (usingWorker) {
        this.state.workerReady = true
        this.emitWorkerState(true, true, this.state.sessionId)
      }
    }
  }

  private async loadPgsBuffer(data: Uint8Array, preserveSource: boolean): Promise<void> {
    if (this.state.useWorker) {
      try {
        this.state.sessionId = createWorkerSessionId()
        await getOrCreateWorker()
        this.emitWorkerState(true, false, this.state.sessionId)
        const transferableData = createTransferableBuffer(data, preserveSource)
        const loadResponse = await sendToWorker({
          type: 'loadPgs',
          sessionId: this.state.sessionId,
          data: transferableData
        })

        if (loadResponse.type === 'pgsLoaded') {
          this.state.workerReady = true
          this.state.metadata = loadResponse.metadata
          this.state.timestamps = loadResponse.timestamps
          this.isLoaded = true
          this.setParserMetadata(loadResponse.metadata)
          this.emitIndexed('pgs', loadResponse.metadata, false)
          this.emitWorkerState(true, true, this.state.sessionId)
          return
        } else if (loadResponse.type === 'error') {
          throw new Error(loadResponse.message)
        }
      } catch (workerError) {
        this.state.useWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
        this.emitWarning(
          createSubtitleWarning(
            'WORKER_FALLBACK',
            'PGS worker initialization failed, falling back to main-thread rendering.',
            {
              format: 'pgs',
              details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
            }
          )
        )
      }
    }

    await this.loadOnMainThread(data)
  }

  private async loadPgsStreaming(url: string): Promise<void> {
    let usedWorker = false
    let indexedOnce = false

    if (this.state.useWorker) {
      try {
        this.state.sessionId = createWorkerSessionId()
        await getOrCreateWorker()
        this.emitWorkerState(true, false, this.state.sessionId)
        const begin = await sendToWorker({ type: 'beginPgs', sessionId: this.state.sessionId })
        if (begin.type === 'error') throw new Error(begin.message)
        usedWorker = true
      } catch (workerError) {
        this.state.useWorker = false
        usedWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
        this.emitWarning(
          createSubtitleWarning(
            'WORKER_FALLBACK',
            'PGS worker initialization failed, falling back to main-thread rendering.',
            {
              format: 'pgs',
              details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
            }
          )
        )
      }
    }

    if (!usedWorker) {
      await this.yieldToMain()
      this.pgsParser = new PgsParser({ debug: this.debug, onWarning: (warning) => this.emitWarning(warning) })
      this.pgsParser.reset()
    }

    try {
      const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(
        url,
        {
          preferRange: this.rangeRequests,
          onProgress: (progress) => this.emitLoadProgress('pgs', progress, this.state.timestamps.length)
        },
        async (chunk, progress) => {
          if (chunk.byteLength === 0) return

          if (usedWorker && this.state.sessionId) {
            const transferable = createTransferableBuffer(chunk, true)
            const response = await sendToWorker({
              type: 'appendPgs',
              sessionId: this.state.sessionId,
              data: transferable
            })
            if (response.type === 'pgsProgress') {
              if (response.added > 0 || !indexedOnce) {
                this.applyPgsIndexState(response.metadata, response.timestamps, true, true)
                indexedOnce = true
              } else {
                this.state.timestamps = response.timestamps
                this.state.metadata = response.metadata
              }
            } else if (response.type === 'error') {
              throw new Error(response.message)
            }
          } else if (this.pgsParser) {
            const added = this.pgsParser.feed(chunk)
            if (added > 0 || !indexedOnce) {
              const metadata = this.pgsParser.getMetadata()
              this.applyPgsIndexState(metadata, this.pgsParser.getTimestamps(), true, false)
              indexedOnce = true
            }
          }

          this.emitLoadProgress('pgs', progress, this.state.timestamps.length)
        }
      )

      if (usedWorker && this.state.sessionId) {
        const finish = await sendToWorker({ type: 'finishPgs', sessionId: this.state.sessionId })
        if (finish.type === 'pgsProgress') {
          this.applyPgsIndexState(finish.metadata, finish.timestamps, false, true)
          this.state.workerReady = true
          this.isLoaded = true
          this.emitWorkerState(true, true, this.state.sessionId)
        } else if (finish.type === 'error') {
          throw new Error(finish.message)
        }
      } else if (this.pgsParser) {
        this.pgsParser.finishFeed()
        const metadata = this.pgsParser.getMetadata()
        this.state.timestamps = this.pgsParser.getTimestamps()
        this.state.metadata = metadata
        this.isLoaded = true
        this.setParserMetadata(metadata)
        this.emitIndexed('pgs', metadata, false)
        if (metadata.cueCount === 0) {
          this.state.renderIssues.set(-1, 'INVALID_SUBTITLE_DATA')
        }
      }

      this.emitLoadProgress(
        'pgs',
        {
          loaded: data.byteLength,
          total: total ?? data.byteLength,
          ratio: 1,
          rangeSupported,
          strategy: strategy as AssetFetchStrategy
        },
        this.state.timestamps.length
      )
    } catch (error) {
      if (usedWorker) {
        this.state.useWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
      }
      this.emitWarning(
        createSubtitleWarning('RANGE_FALLBACK', 'Progressive PGS load failed; retrying with a full buffer fetch.', {
          format: 'pgs',
          details: { reason: error instanceof Error ? error.message : String(error) }
        })
      )
      const { data } = await fetchSubtitleAsset(url, { preferRange: this.rangeRequests })
      await this.loadPgsBuffer(data, false)
    }
  }

  private async loadOnMainThread(data: Uint8Array): Promise<void> {
    await this.yieldToMain()

    this.pgsParser = new PgsParser({ debug: this.debug, onWarning: (warning) => this.emitWarning(warning) })

    await new Promise<void>((resolve) => {
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
        this.emitIndexed('pgs', this.state.metadata, false)
        if (count === 0) {
          this.state.renderIssues.set(-1, 'INVALID_SUBTITLE_DATA')
        }
        resolve()
      })
    })
  }

  protected getWorkerRendererState(): WorkerRendererState {
    return this.state
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
        const renderTask = sendToWorker({
          type: 'renderPgsAtIndex',
          sessionId: this.state.sessionId!,
          index
        }).then((response) => {
          if (response.type === 'pgsFrame') {
            return {
              frame: response.frame ? convertFrameData(response.frame) : null,
              renderIssue: response.renderIssue?.trim() || null
            }
          }

          return { frame: null, renderIssue: null }
        })

        const renderPromise = renderTask.then(({ frame }) => frame)

        this.state.pendingRenders.set(index, renderPromise)
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        renderTask.then(({ frame, renderIssue }) => {
          setCachedFrame(this.state, index, frame, renderIssue)
          this.state.pendingRenders.delete(index)
          this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        })
      }
      this.watchPendingRender(index, this.state.pendingRenders.get(index)!)
      // Return undefined to indicate async loading in progress
      return undefined
    }

    const rendered = this.pgsParser?.renderAtIndex(index) ?? null
    setCachedFrame(this.state, index, rendered, this.pgsParser?.getLastRenderIssue() ?? null)
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
    const offscreenFrame = this.getOffscreenFrameMetadata(index)

    return {
      index,
      format: 'pgs',
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      screenWidth: metadata.screenWidth,
      screenHeight: metadata.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : (offscreenFrame?.bounds ?? null),
      compositionCount: frame?.compositionData.length ?? offscreenFrame?.compositionCount ?? 0
    }
  }

  protected isPendingRender(index: number): boolean {
    return this.state.pendingRenders.has(index)
  }

  protected onSeek(): void {
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
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
    this.invalidatePresentation()
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
    this.state.pendingRenders.clear()
    this.clearOffscreenFrameMetadata()
    this.lastRenderedIndex = -1
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearPgsCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.pgsParser?.clearCache()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    this.renderPausedFrame()
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
    this.state.renderIssues.clear()
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
  private fileName?: string
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
    this.idxUrl =
      options.idxUrl ||
      (options.subUrl && /\.sub$/i.test(options.subUrl) ? options.subUrl.replace(/\.sub$/i, '.idx') : undefined)
    this.idxContent = options.idxContent
    this.fileName = options.fileName
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

      const useMksSource =
        !this.idxContent &&
        !this.idxUrl &&
        isMksSource({
          subData: this.subContent,
          fileName: this.fileName,
          subUrl: this.subUrl
        })

      if (this.subContent && (useMksSource || this.idxContent)) {
        const subData = new Uint8Array(this.subContent)
        this.emitLoadProgress('vobsub', this.memoryProgress(subData.byteLength), 0)
        await this.loadVobSubBuffer(subData, this.idxContent, useMksSource, true)
        this.onLoaded?.()
        return
      }

      if (useMksSource) {
        await this.loadVobSubMksStreaming()
        this.onLoaded?.()
        return
      }

      await this.loadVobSubIdxSubStreaming()
      this.onLoaded?.()
    } catch (error) {
      const resolvedError = normalizeSubtitleError(error, { format: 'vobsub' })
      this.emitEvent({ type: 'error', format: 'vobsub', error: resolvedError })
      this.onError?.(resolvedError)
    }
  }

  private applyVobSubIndexState(
    metadata: SubtitleParserMetadata,
    timestamps: Float64Array,
    partial: boolean,
    renderable: boolean,
    usingWorker: boolean
  ): void {
    this.state.metadata = metadata
    this.state.timestamps = timestamps
    this.setParserMetadata(metadata)
    this.emitIndexed('vobsub', metadata, partial)
    if (renderable && !this.isLoaded && timestamps.length > 0) {
      this.isLoaded = true
      if (usingWorker) {
        this.state.workerReady = true
        this.emitWorkerState(true, true, this.state.sessionId)
      }
    }
  }

  private async ensureVobSubWorkerSession(): Promise<boolean> {
    if (!this.state.useWorker) return false
    try {
      this.state.sessionId = createWorkerSessionId()
      await getOrCreateWorker()
      this.emitWorkerState(true, false, this.state.sessionId)
      return true
    } catch (workerError) {
      this.state.useWorker = false
      this.emitWorkerState(false, false, this.state.sessionId, true)
      this.emitWarning(
        createSubtitleWarning(
          'WORKER_FALLBACK',
          'VobSub worker initialization failed, falling back to main-thread rendering.',
          {
            format: 'vobsub',
            details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
          }
        )
      )
      return false
    }
  }

  private async loadVobSubBuffer(
    subData: Uint8Array,
    idxData: string | undefined,
    useMksSource: boolean,
    preserveSource: boolean
  ): Promise<void> {
    if (await this.ensureVobSubWorkerSession()) {
      try {
        const transferableSubData = createTransferableBuffer(subData, preserveSource)
        const loadResponse = await sendToWorker(
          useMksSource
            ? {
                type: 'loadVobSubMks',
                sessionId: this.state.sessionId!,
                subData: transferableSubData
              }
            : {
                type: 'loadVobSub',
                sessionId: this.state.sessionId!,
                idxContent: idxData!,
                subData: transferableSubData
              }
        )

        if (loadResponse.type === 'vobSubLoaded') {
          if (!useMksSource && idxData && loadResponse.count === 0) {
            throw createSubtitleDiagnosticError('BAD_IDX', 'IDX metadata did not yield any subtitle timestamps.', {
              format: 'vobsub'
            })
          }
          this.state.workerReady = true
          this.state.metadata = loadResponse.metadata
          this.state.timestamps = loadResponse.timestamps
          this.isLoaded = true
          this.setParserMetadata(loadResponse.metadata)
          this.emitIndexed('vobsub', loadResponse.metadata, false)
          this.emitWorkerState(true, true, this.state.sessionId)
          return
        } else if (loadResponse.type === 'error') {
          throw new Error(loadResponse.message)
        }
      } catch (workerError) {
        if (workerError instanceof SubtitleDiagnosticError && workerError.code === 'BAD_IDX') {
          throw workerError
        }
        this.state.useWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
        this.emitWarning(
          createSubtitleWarning(
            'WORKER_FALLBACK',
            'VobSub worker load failed, falling back to main-thread rendering.',
            {
              format: 'vobsub',
              details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
            }
          )
        )
      }
    }

    await this.loadOnMainThread(subData, idxData, useMksSource)
  }

  private async loadVobSubMksStreaming(): Promise<void> {
    if (this.subContent) {
      await this.loadVobSubBuffer(new Uint8Array(this.subContent), undefined, true, true)
      return
    }
    if (!this.subUrl) {
      throw createSubtitleDiagnosticError('MISSING_INPUT', 'No SUB content or URL provided.', { format: 'vobsub' })
    }

    const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(this.subUrl, {
      preferRange: this.rangeRequests && this.streamingLoad,
      onProgress: (progress) => this.emitLoadProgress('vobsub', progress, this.state.timestamps.length)
    })
    this.emitLoadProgress(
      'vobsub',
      {
        loaded: data.byteLength,
        total: total ?? data.byteLength,
        ratio: 1,
        rangeSupported,
        strategy
      },
      0
    )
    await this.loadVobSubBuffer(data, undefined, true, false)
  }

  private async loadVobSubIdxSubStreaming(): Promise<void> {
    let idxData = this.idxContent
    if (!idxData) {
      if (!this.idxUrl) {
        throw createSubtitleDiagnosticError('MISSING_INPUT', 'No IDX content or URL provided.', { format: 'vobsub' })
      }
      idxData = await fetchSubtitleText(this.idxUrl, {
        onProgress: (progress) => this.emitLoadProgress('vobsub', progress, 0)
      })
    }

    let usedWorker = await this.ensureVobSubWorkerSession()
    if (usedWorker && this.state.sessionId) {
      try {
        const idxResponse = await sendToWorker({
          type: 'loadVobSubIdx',
          sessionId: this.state.sessionId,
          idxContent: idxData
        })
        if (idxResponse.type === 'vobSubProgress') {
          if (idxResponse.count === 0) {
            throw createSubtitleDiagnosticError('BAD_IDX', 'IDX metadata did not yield any subtitle timestamps.', {
              format: 'vobsub'
            })
          }
          this.applyVobSubIndexState(idxResponse.metadata, idxResponse.timestamps, true, false, true)
          this.state.workerReady = true
          this.emitWorkerState(true, true, this.state.sessionId)
        } else if (idxResponse.type === 'error') {
          throw new Error(idxResponse.message)
        }
      } catch (error) {
        if (error instanceof SubtitleDiagnosticError && error.code === 'BAD_IDX') {
          throw error
        }
        usedWorker = false
        this.state.useWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
        this.emitWarning(
          createSubtitleWarning(
            'WORKER_FALLBACK',
            'VobSub worker IDX load failed, falling back to main-thread rendering.',
            {
              format: 'vobsub',
              details: { reason: error instanceof Error ? error.message : String(error) }
            }
          )
        )
      }
    }

    if (!usedWorker) {
      await this.yieldToMain()
      this.vobsubParser = new VobSubParserLowLevel({
        debug: this.debug,
        onWarning: (warning) => this.emitWarning(warning)
      })
      this.vobsubParser.loadFromIdx(idxData)
      this.applyVobSubIndexState(this.vobsubParser.getMetadata(), this.vobsubParser.getTimestamps(), true, false, false)
    }

    let subData: Uint8Array
    if (this.subContent) {
      subData = new Uint8Array(this.subContent)
      this.emitLoadProgress('vobsub', this.memoryProgress(subData.byteLength), this.state.timestamps.length)
    } else {
      if (!this.subUrl) {
        throw createSubtitleDiagnosticError('MISSING_INPUT', 'No SUB content or URL provided.', { format: 'vobsub' })
      }
      const fetched = await fetchSubtitleAsset(this.subUrl, {
        preferRange: this.rangeRequests && this.streamingLoad,
        onProgress: (progress) => this.emitLoadProgress('vobsub', progress, this.state.timestamps.length)
      })
      subData = fetched.data
      this.emitLoadProgress(
        'vobsub',
        {
          loaded: subData.byteLength,
          total: fetched.total ?? subData.byteLength,
          ratio: 1,
          rangeSupported: fetched.rangeSupported,
          strategy: fetched.strategy
        },
        this.state.timestamps.length
      )
    }

    if (usedWorker && this.state.sessionId) {
      const transferable = createTransferableBuffer(subData, Boolean(this.subContent))
      const attachResponse = await sendToWorker({
        type: 'attachVobSubData',
        sessionId: this.state.sessionId,
        subData: transferable
      })
      if (attachResponse.type === 'vobSubProgress') {
        this.applyVobSubIndexState(attachResponse.metadata, attachResponse.timestamps, false, true, true)
        this.state.workerReady = true
        this.isLoaded = true
        this.emitWorkerState(true, true, this.state.sessionId)
        return
      } else if (attachResponse.type === 'error') {
        throw new Error(attachResponse.message)
      }
    }

    if (!this.vobsubParser) {
      this.vobsubParser = new VobSubParserLowLevel({
        debug: this.debug,
        onWarning: (warning) => this.emitWarning(warning)
      })
      this.vobsubParser.loadFromIdx(idxData)
    }
    this.vobsubParser.attachSubData(subData)
    const metadata = this.vobsubParser.getMetadata()
    this.state.timestamps = this.vobsubParser.getTimestamps()
    this.state.metadata = metadata
    this.isLoaded = true
    this.setParserMetadata(metadata)
    this.emitIndexed('vobsub', metadata, false)
  }

  private async loadOnMainThread(subData: Uint8Array, idxData?: string, useMksSource: boolean = false): Promise<void> {
    await this.yieldToMain()

    this.vobsubParser = new VobSubParserLowLevel({
      debug: this.debug,
      onWarning: (warning) => this.emitWarning(warning)
    })

    await new Promise<void>((resolve) => {
      const scheduleTask =
        typeof requestIdleCallback !== 'undefined'
          ? (cb: () => void) => requestIdleCallback(() => cb(), { timeout: 1000 })
          : (cb: () => void) => setTimeout(cb, 0)

      scheduleTask(() => {
        if (useMksSource) {
          this.vobsubParser!.loadFromMks(subData)
        } else if (idxData) {
          this.vobsubParser!.loadFromData(idxData, subData)
        } else {
          this.vobsubParser!.loadFromSubOnly(subData)
        }
        this.state.timestamps = this.vobsubParser!.getTimestamps()
        this.state.metadata = this.vobsubParser!.getMetadata()
        this.isLoaded = true
        this.setParserMetadata(this.state.metadata)
        this.emitIndexed('vobsub', this.state.metadata, false)
        resolve()
      })
    })
  }

  protected getWorkerRendererState(): WorkerRendererState {
    return this.state
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
        const presentationToken = this.getPresentationToken()
        const lookup = sendToWorker({
          type: 'findVobSubIndex',
          sessionId: this.state.sessionId!,
          timeMs
        }).then((response) => {
          if (!this.isCurrentPresentation(presentationToken)) return this.cachedIndex
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
          return this.cachedIndex
        })
        this.pendingIndexLookup = lookup
        void lookup.then(
          () => {
            if (this.pendingIndexLookup !== lookup) return
            this.pendingIndexLookup = null
            this.renderPausedFrame()
          },
          () => {
            if (this.pendingIndexLookup === lookup) this.pendingIndexLookup = null
          }
        )
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
        const renderTask = sendToWorker({
          type: 'renderVobSubAtIndex',
          sessionId: this.state.sessionId!,
          index
        }).then((response) => {
          if (response.type === 'vobSubFrame') {
            return {
              frame: response.frame ? convertFrameData(response.frame) : null,
              renderIssue: response.renderIssue?.trim() || null
            }
          }

          return { frame: null, renderIssue: null }
        })

        const renderPromise = renderTask.then(({ frame }) => frame)

        this.state.pendingRenders.set(index, renderPromise)
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        renderTask.then(({ frame, renderIssue }) => {
          setCachedFrame(this.state, index, frame, renderIssue)
          this.state.pendingRenders.delete(index)
          this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        })
      }
      this.watchPendingRender(index, this.state.pendingRenders.get(index)!)
      // Return undefined to indicate async loading in progress
      return undefined
    }

    const rendered = this.vobsubParser?.renderAtIndex(index) ?? null
    setCachedFrame(this.state, index, rendered, this.vobsubParser?.getLastRenderIssue() ?? null)
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
    const offscreenFrame = this.getOffscreenFrameMetadata(index)

    return {
      index,
      format: 'vobsub',
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      screenWidth: metadata.screenWidth,
      screenHeight: metadata.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : (offscreenFrame?.bounds ?? null),
      compositionCount: frame?.compositionData.length ?? offscreenFrame?.compositionCount ?? 0,
      language: metadata.language ?? null,
      trackId: metadata.trackId ?? null
    }
  }

  protected isPendingRender(index: number): boolean {
    return this.state.pendingRenders.has(index)
  }

  protected onSeek(): void {
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
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
    this.invalidatePresentation()
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
    this.state.pendingRenders.clear()
    this.clearOffscreenFrameMetadata()
    this.cachedIndex = -1
    this.cachedIndexTime = -1
    this.pendingIndexLookup = null
    this.lastRenderedIndex = -1
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearVobSubCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.vobsubParser?.clearCache()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    this.renderPausedFrame()
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
    this.invalidatePresentation()
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.clearOffscreenFrameMetadata()
    this.lastRenderedIndex = -1
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    this.renderPausedFrame()
  }

  /** Set debanding threshold (0-255, default: 64) */
  setDebandThreshold(threshold: number): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandThreshold', sessionId: this.state.sessionId!, threshold }).catch(() => {})
    }
    this.vobsubParser?.setDebandThreshold(threshold)
    this.invalidatePresentation()
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.clearOffscreenFrameMetadata()
    this.lastRenderedIndex = -1
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    this.renderPausedFrame()
  }

  /** Set debanding sample range in pixels (1-64, default: 15) */
  setDebandRange(range: number): void {
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'setVobSubDebandRange', sessionId: this.state.sessionId!, range }).catch(() => {})
    }
    this.vobsubParser?.setDebandRange(range)
    this.invalidatePresentation()
    // Clear cache to force re-render with new settings
    this.state.frameCache.clear()
    this.clearOffscreenFrameMetadata()
    this.lastRenderedIndex = -1
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    this.renderPausedFrame()
  }

  /** Check if debanding is enabled */
  get debandEnabled(): boolean {
    return this.vobsubParser?.debandEnabled ?? true
  }

  dispose(): void {
    super.dispose()
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
    this.state.pendingRenders.clear()
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'disposeVobSub', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.vobsubParser?.dispose()
    this.vobsubParser = null
    this.state.sessionId = null
  }
}

export class DvbRenderer extends BaseVideoSubtitleRenderer {
  private dvbParser: DvbParser | null = null
  private endTimestamps: Float64Array = new Float64Array(0)
  private state = createWorkerState()
  private onLoading?: () => void
  private onLoaded?: () => void
  private onError?: (error: Error) => void

  constructor(options: VideoSubtitleOptions) {
    super(options, 'dvb')
    this.onLoading = options.onLoading
    this.onLoaded = options.onLoaded
    this.onError = options.onError
    applyCacheLimit(this.state, this.cacheLimit)
    this.startInit()
  }

  protected async loadSubtitles(): Promise<void> {
    try {
      this.emitEvent({ type: 'loading', format: 'dvb' })
      this.onLoading?.()

      if (this.subContent) {
        const data = new Uint8Array(this.subContent)
        this.emitLoadProgress('dvb', this.memoryProgress(data.byteLength), 0)
        await this.loadDvbBuffer(data, true)
        this.onLoaded?.()
        return
      }

      if (!this.subUrl) {
        throw new Error('No subtitle content or URL provided')
      }

      if (!this.streamingLoad) {
        const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(this.subUrl, {
          preferRange: this.rangeRequests,
          onProgress: (progress) => this.emitLoadProgress('dvb', progress, this.state.timestamps.length)
        })
        this.emitLoadProgress(
          'dvb',
          { loaded: data.byteLength, total: total ?? data.byteLength, ratio: 1, rangeSupported, strategy },
          0
        )
        await this.loadDvbBuffer(data, false)
        this.onLoaded?.()
        return
      }

      await this.loadDvbStreaming(this.subUrl)
      this.onLoaded?.()
    } catch (error) {
      const resolvedError = normalizeSubtitleError(error, { format: 'dvb' })
      this.emitEvent({ type: 'error', format: 'dvb', error: resolvedError })
      this.onError?.(resolvedError)
    }
  }

  private applyDvbIndexState(
    metadata: SubtitleParserMetadata,
    timestamps: Float64Array,
    endTimestamps: Float64Array,
    partial: boolean,
    usingWorker: boolean
  ): void {
    this.state.metadata = metadata
    this.state.timestamps = timestamps
    this.endTimestamps = endTimestamps
    this.setParserMetadata(metadata)
    this.emitIndexed('dvb', metadata, partial)
    if (!this.isLoaded && timestamps.length > 0) {
      this.isLoaded = true
      if (usingWorker) {
        this.state.workerReady = true
        this.emitWorkerState(true, true, this.state.sessionId)
      }
    }
  }

  private async loadDvbBuffer(data: Uint8Array, preserveSource: boolean): Promise<void> {
    if (this.state.useWorker) {
      try {
        this.state.sessionId = createWorkerSessionId()
        await getOrCreateWorker()
        this.emitWorkerState(true, false, this.state.sessionId)
        const transferableData = createTransferableBuffer(data, preserveSource)
        const loadResponse = await sendToWorker({
          type: 'loadDvb',
          sessionId: this.state.sessionId,
          data: transferableData
        })

        if (loadResponse.type === 'dvbLoaded') {
          this.state.workerReady = true
          this.state.metadata = loadResponse.metadata
          this.state.timestamps = loadResponse.timestamps
          this.endTimestamps = loadResponse.endTimestamps
          this.isLoaded = true
          this.setParserMetadata(loadResponse.metadata)
          this.emitIndexed('dvb', loadResponse.metadata, false)
          this.emitWorkerState(true, true, this.state.sessionId)
          return
        } else if (loadResponse.type === 'error') {
          throw new Error(loadResponse.message)
        }
      } catch (workerError) {
        this.state.useWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
        this.emitWarning(
          createSubtitleWarning(
            'WORKER_FALLBACK',
            'DVB worker initialization failed, falling back to main-thread rendering.',
            {
              format: 'dvb',
              details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
            }
          )
        )
      }
    }

    await this.loadOnMainThread(data)
  }

  private async loadDvbStreaming(url: string): Promise<void> {
    let usedWorker = false
    let indexedOnce = false

    if (this.state.useWorker) {
      try {
        this.state.sessionId = createWorkerSessionId()
        await getOrCreateWorker()
        this.emitWorkerState(true, false, this.state.sessionId)
        const begin = await sendToWorker({ type: 'beginDvb', sessionId: this.state.sessionId })
        if (begin.type === 'error') throw new Error(begin.message)
        usedWorker = true
      } catch (workerError) {
        this.state.useWorker = false
        usedWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
        this.emitWarning(
          createSubtitleWarning(
            'WORKER_FALLBACK',
            'DVB worker initialization failed, falling back to main-thread rendering.',
            {
              format: 'dvb',
              details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
            }
          )
        )
      }
    }

    if (!usedWorker) {
      await this.yieldToMain()
      this.dvbParser = new DvbParser({ debug: this.debug, onWarning: (warning) => this.emitWarning(warning) })
      this.dvbParser.reset()
    }

    try {
      const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(
        url,
        {
          preferRange: this.rangeRequests,
          onProgress: (progress) => this.emitLoadProgress('dvb', progress, this.state.timestamps.length)
        },
        async (chunk, progress) => {
          if (chunk.byteLength === 0) return

          if (usedWorker && this.state.sessionId) {
            const transferable = createTransferableBuffer(chunk, true)
            const response = await sendToWorker({
              type: 'appendDvb',
              sessionId: this.state.sessionId,
              data: transferable
            })
            if (response.type === 'dvbProgress') {
              if (response.added > 0 || !indexedOnce) {
                this.applyDvbIndexState(response.metadata, response.timestamps, response.endTimestamps, true, true)
                indexedOnce = true
              } else {
                this.state.timestamps = response.timestamps
                this.endTimestamps = response.endTimestamps
                this.state.metadata = response.metadata
              }
            } else if (response.type === 'error') {
              throw new Error(response.message)
            }
          } else if (this.dvbParser) {
            const added = this.dvbParser.feed(chunk)
            if (added > 0 || !indexedOnce) {
              const metadata = this.dvbParser.getMetadata()
              this.applyDvbIndexState(
                metadata,
                this.dvbParser.getTimestamps(),
                this.dvbParser.getEndTimestamps(),
                true,
                false
              )
              indexedOnce = true
            }
          }

          this.emitLoadProgress('dvb', progress, this.state.timestamps.length)
        }
      )

      if (usedWorker && this.state.sessionId) {
        const finish = await sendToWorker({ type: 'finishDvb', sessionId: this.state.sessionId })
        if (finish.type === 'dvbProgress') {
          this.applyDvbIndexState(finish.metadata, finish.timestamps, finish.endTimestamps, false, true)
          this.state.workerReady = true
          this.isLoaded = true
          this.emitWorkerState(true, true, this.state.sessionId)
        } else if (finish.type === 'error') {
          throw new Error(finish.message)
        }
      } else if (this.dvbParser) {
        this.dvbParser.finishFeed()
        const metadata = this.dvbParser.getMetadata()
        this.state.timestamps = this.dvbParser.getTimestamps()
        this.endTimestamps = this.dvbParser.getEndTimestamps()
        this.state.metadata = metadata
        this.isLoaded = true
        this.setParserMetadata(metadata)
        this.emitIndexed('dvb', metadata, false)
        if (metadata.cueCount === 0) {
          this.state.renderIssues.set(-1, 'INVALID_SUBTITLE_DATA')
        }
      }

      this.emitLoadProgress(
        'dvb',
        {
          loaded: data.byteLength,
          total: total ?? data.byteLength,
          ratio: 1,
          rangeSupported,
          strategy: strategy as AssetFetchStrategy
        },
        this.state.timestamps.length
      )
    } catch (error) {
      if (usedWorker) {
        this.state.useWorker = false
        this.emitWorkerState(false, false, this.state.sessionId, true)
      }
      this.emitWarning(
        createSubtitleWarning('RANGE_FALLBACK', 'Progressive DVB load failed; retrying with a full buffer fetch.', {
          format: 'dvb',
          details: { reason: error instanceof Error ? error.message : String(error) }
        })
      )
      const { data } = await fetchSubtitleAsset(url, { preferRange: this.rangeRequests })
      await this.loadDvbBuffer(data, false)
    }
  }

  private async loadOnMainThread(data: Uint8Array): Promise<void> {
    await this.yieldToMain()

    this.dvbParser = new DvbParser({ debug: this.debug, onWarning: (warning) => this.emitWarning(warning) })

    await new Promise<void>((resolve) => {
      const scheduleTask =
        typeof requestIdleCallback !== 'undefined'
          ? (cb: () => void) => requestIdleCallback(() => cb(), { timeout: 1000 })
          : (cb: () => void) => setTimeout(cb, 0)

      scheduleTask(() => {
        const count = this.dvbParser!.load(data)
        this.state.timestamps = this.dvbParser!.getTimestamps()
        this.endTimestamps = this.dvbParser!.getEndTimestamps()
        this.state.metadata = this.dvbParser!.getMetadata()
        this.isLoaded = true
        this.setParserMetadata(this.state.metadata)
        this.emitIndexed('dvb', this.state.metadata, false)
        if (count === 0) {
          this.state.renderIssues.set(-1, 'INVALID_SUBTITLE_DATA')
        }
        resolve()
      })
    })
  }

  protected getWorkerRendererState(): WorkerRendererState {
    return this.state
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
      const timeMs = time * 1000
      const index = binarySearchTimestamp(this.state.timestamps, timeMs)
      return index >= 0 && timeMs < (this.endTimestamps[index] ?? this.state.timestamps[index]) ? index : -1
    }
    return this.dvbParser?.findIndexAtTimestamp(time) ?? -1
  }

  protected renderAtIndex(index: number): SubtitleData | undefined {
    if (this.state.frameCache.has(index)) {
      return this.state.frameCache.get(index) ?? undefined
    }

    if (this.state.useWorker && this.state.workerReady) {
      if (!this.state.pendingRenders.has(index)) {
        const renderTask = sendToWorker({
          type: 'renderDvbAtIndex',
          sessionId: this.state.sessionId!,
          index
        }).then((response) => {
          if (response.type === 'dvbFrame') {
            return {
              frame: response.frame ? convertFrameData(response.frame) : null,
              renderIssue: response.renderIssue?.trim() || null
            }
          }

          return { frame: null, renderIssue: null }
        })

        const renderPromise = renderTask.then(({ frame }) => frame)

        this.state.pendingRenders.set(index, renderPromise)
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        renderTask.then(({ frame, renderIssue }) => {
          setCachedFrame(this.state, index, frame, renderIssue)
          this.state.pendingRenders.delete(index)
          this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
        })
      }
      this.watchPendingRender(index, this.state.pendingRenders.get(index)!)
      // Return undefined to indicate async loading in progress
      return undefined
    }

    const rendered = this.dvbParser?.renderAtIndex(index) ?? null
    setCachedFrame(this.state, index, rendered, this.dvbParser?.getLastRenderIssue() ?? null)
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    return rendered ?? undefined
  }

  protected buildCueMetadata(index: number): SubtitleCueMetadata | null {
    if (this.dvbParser) {
      return this.dvbParser.getCueMetadata(index)
    }

    const metadata = this.state.metadata
    if (!metadata || index < 0 || index >= this.state.timestamps.length) return null

    const startTime = this.state.timestamps[index]
    const endTime = this.endTimestamps[index] ?? startTime
    const frame = this.state.frameCache.get(index) ?? null
    const offscreenFrame = this.getOffscreenFrameMetadata(index)

    return {
      index,
      format: 'dvb',
      startTime,
      endTime,
      duration: Math.max(0, endTime - startTime),
      screenWidth: metadata.screenWidth,
      screenHeight: metadata.screenHeight,
      bounds: frame ? getSubtitleBounds(frame) : (offscreenFrame?.bounds ?? null),
      compositionCount: frame?.compositionData.length ?? offscreenFrame?.compositionCount ?? 0
    }
  }

  protected isPendingRender(index: number): boolean {
    return this.state.pendingRenders.has(index)
  }

  protected onSeek(): void {
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
    this.state.pendingRenders.clear()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearDvbCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.dvbParser?.clearCache()
  }

  setCacheLimit(limit: number): void {
    this.cacheLimit = applyCacheLimit(this.state, limit)
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
  }

  clearFrameCache(): void {
    this.invalidatePresentation()
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
    this.state.pendingRenders.clear()
    this.clearOffscreenFrameMetadata()
    this.lastRenderedIndex = -1
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'clearDvbCache', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.dvbParser?.clearCache()
    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size)
    this.renderPausedFrame()
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

  /** Get performance statistics for DVB renderer */
  getStats(): SubtitleRendererStats {
    const baseStats = this.getBaseStats()
    return {
      ...baseStats,
      usingWorker: this.state.useWorker && this.state.workerReady,
      cachedFrames: this.state.frameCache.size,
      pendingRenders: this.state.pendingRenders.size,
      totalEntries: this.state.timestamps.length || (this.dvbParser?.getTimestamps().length ?? 0)
    }
  }

  dispose(): void {
    super.dispose()
    this.state.frameCache.clear()
    this.state.renderIssues.clear()
    this.state.pendingRenders.clear()
    if (this.state.useWorker && this.state.workerReady) {
      sendToWorker({ type: 'disposeDvb', sessionId: this.state.sessionId! }).catch(() => {})
    }
    this.dvbParser?.dispose()
    this.dvbParser = null
    this.endTimestamps = new Float64Array(0)
    this.state.sessionId = null
  }
}

/**
 * High-level VobSub subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */

/** Create a video subtitle renderer with automatic format detection. */
export function createAutoSubtitleRenderer(
  options: AutoVideoSubtitleOptions
): PgsRenderer | VobSubRenderer | DvbRenderer {
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

  if (format === 'dvb') {
    return new DvbRenderer(options)
  }

  if (format === 'vobsub') {
    return new VobSubRenderer(options)
  }

  throw new Error('Unable to detect subtitle format for video renderer')
}
