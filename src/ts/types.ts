/**
 * Type definitions for libbitsub TypeScript wrapper.
 */

import type {
  SubtitleRenderer as WasmSubtitleRenderer,
  PgsParser as WasmPgsParser,
  VobSubParser as WasmVobSubParser,
  DvbParser as WasmDvbParser,
  RenderResult,
  SubtitleFrame,
  VobSubFrame
} from '../../pkg/libbitsub'

// Re-export WASM types
export type {
  WasmSubtitleRenderer,
  WasmPgsParser,
  WasmVobSubParser,
  WasmDvbParser,
  RenderResult,
  SubtitleFrame,
  VobSubFrame
}

/** Detected graphical subtitle format. */
export type SubtitleFormatName = 'pgs' | 'vobsub' | 'dvb'

/** Horizontal alignment used when placing a subtitle overlay. */
export type SubtitleHorizontalAlign = 'left' | 'center' | 'right'

/** How bitmap subtitles are fit into the video overlay. */
export type SubtitleAspectMode = 'stretch' | 'contain' | 'cover'

/** Primitive value stored on a diagnostic error or warning. */
export type SubtitleDiagnosticDetailValue = string | number | boolean | null | undefined

/** Stable diagnostic error code. */
export type SubtitleDiagnosticErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'BAD_IDX'
  | 'MISSING_PALETTE'
  | 'TRACK_NOT_FOUND'
  | 'MISSING_INPUT'
  | 'FETCH_FAILED'
  | 'INVALID_SUBTITLE_DATA'
  | 'WORKER_FALLBACK'
  | 'UNKNOWN'

/** Stable diagnostic warning code. */
export type SubtitleDiagnosticWarningCode =
  | 'BAD_IDX'
  | 'INVALID_FRAME_DATA'
  | 'INVALID_SUBTITLE_DATA'
  | 'MISSING_PALETTE'
  | 'RANGE_FALLBACK'
  | 'WORKER_FALLBACK'

/** Strategy used to fetch a subtitle asset. */
export type AssetFetchStrategy = 'memory' | 'stream' | 'range-chunks' | 'basic'

/** Non-fatal diagnostic emitted while loading or rendering. */
export interface SubtitleDiagnosticWarning {
  code: SubtitleDiagnosticWarningCode
  message: string
  format?: SubtitleFormatName
  cueIndex?: number
  details?: Record<string, SubtitleDiagnosticDetailValue>
}

/** Error shape used by SubtitleDiagnosticError. */
export interface SubtitleDiagnosticErrorLike extends Error {
  code: SubtitleDiagnosticErrorCode
  format?: SubtitleFormatName
  details?: Record<string, SubtitleDiagnosticDetailValue>
  cause?: unknown
}

/** Options for forwarding diagnostic warnings. */
export interface SubtitleDiagnosticsOptions {
  debug?: boolean
  onWarning?: (warning: SubtitleDiagnosticWarning) => void
}

/** Binary chunk accepted by the live PGS/DVB renderer push API. */
export type SubtitleStreamChunk = ArrayBuffer | Uint8Array

/** Incremental input surface implemented by the live PGS and DVB video renderers. */
export interface LiveSubtitleRenderer {
  /** Append bytes and resolve with the number of newly indexed cues. */
  append(data: SubtitleStreamChunk): Promise<number>
  /** Discard any incomplete trailing input and resolve with the total cue count. */
  flush(): Promise<number>
  /** Clear all stream/parser state while keeping the renderer ready for new input. */
  reset(): Promise<void>
}

// =============================================================================
// Subtitle Data Types
// =============================================================================

/** Subtitle data output format compatible with the original JS implementation. */
export interface SubtitleData {
  /** Total width of the presentation (screen). */
  width: number
  /** Total height of the presentation (screen). */
  height: number
  /** Pre-compiled composition elements. */
  compositionData: SubtitleCompositionData[]
}

/** Whether exported frames keep the full screen or crop to ink. */
export type SubtitleFrameCropMode = 'bounds' | 'screen'

/** Options for flattening a subtitle frame to RGBA. */
export interface SubtitleFrameRenderOptions {
  /** Compose only the visible cue bounds or the full subtitle presentation area. */
  crop?: SubtitleFrameCropMode
}

/** Flattened RGBA subtitle frame plus placement metadata. */
export interface SubtitleRenderedFrameData {
  /** Flattened RGBA pixels for the composed subtitle frame export. */
  imageData: ImageData
  /** Tight cue bounds inside the original subtitle presentation area. */
  bounds: SubtitleCueBounds | null
  /** Top-left draw offset inside the original subtitle presentation area. */
  offsetX: number
  /** Top-left draw offset inside the original subtitle presentation area. */
  offsetY: number
  /** Original subtitle presentation width. */
  screenWidth: number
  /** Original subtitle presentation height. */
  screenHeight: number
  /** Crop mode used to compose imageData. */
  crop: SubtitleFrameCropMode
  /** Number of source compositions folded into the export. */
  compositionCount: number
}

/** Canvas target accepted by toCanvas(). */
export type SubtitleFrameCanvasTarget =
  | HTMLCanvasElement
  | OffscreenCanvas
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

/** Options for drawing a rendered frame onto a canvas. */
export interface SubtitleFrameCanvasOptions extends SubtitleFrameRenderOptions {
  /** Resize the target canvas to the rendered frame size before drawing. */
  resizeCanvas?: boolean
  /** Clear the target canvas before drawing. */
  clearCanvas?: boolean
}

/** A single composition element. */
export interface SubtitleCompositionData {
  /** The compiled pixel data of the subtitle. */
  pixelData: ImageData
  /** X position on screen. */
  x: number
  /** Y position on screen. */
  y: number
}

/** Axis-aligned bounds of a subtitle cue. */
export interface SubtitleCueBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Indexed cue timing and placement metadata. */
export interface SubtitleCueMetadata {
  index: number
  format: SubtitleFormatName
  startTime: number
  endTime: number
  duration: number
  screenWidth: number
  screenHeight: number
  bounds: SubtitleCueBounds | null
  compositionCount: number
  paletteId?: number
  compositionState?: number
  language?: string | null
  trackId?: string | null
  filePosition?: number
}

/** Parser-level track metadata. */
export interface SubtitleParserMetadata {
  format: SubtitleFormatName
  cueCount: number
  screenWidth: number
  screenHeight: number
  language?: string | null
  trackId?: string | null
  hasIdxMetadata?: boolean
}

/** In-memory subtitle document returned by openSubtitles(). */
export interface OpenedSubtitles {
  /** Detected subtitle format after the source has been opened. */
  readonly format: SubtitleFormatName
  /** Snapshot of the loaded parser metadata. */
  readonly metadata: SubtitleParserMetadata
  /** Snapshot of subtitle timestamps in milliseconds. */
  readonly timestamps: Float64Array
  /** Render subtitle data for a cue index. */
  renderAtIndex(index: number): SubtitleData | undefined
  /** Render subtitle data at a timestamp in seconds. */
  renderAtTimestamp(timeSeconds: number): SubtitleData | undefined
  /** Render flattened frame pixels for a cue index. */
  renderFrameDataAtIndex(index: number, options?: SubtitleFrameRenderOptions): SubtitleRenderedFrameData | undefined
  /** Render flattened frame pixels at a timestamp in seconds. */
  renderFrameDataAtTimestamp(
    timeSeconds: number,
    options?: SubtitleFrameRenderOptions
  ): SubtitleRenderedFrameData | undefined
  /** Get cue metadata for a specific cue index. */
  getCueMetadata(index: number): SubtitleCueMetadata | null
  /** Get the latest non-fatal render issue. */
  getLastRenderIssue(): string | null
  /** Clear parser-side caches. */
  clearCache(): void
  /** Dispose parser resources. */
  dispose(): void
}

// =============================================================================
// Video Renderer Options
// =============================================================================

/** Options for video subtitle renderers. */
export interface VideoSubtitleOptions {
  /** The video element to sync with */
  video: HTMLVideoElement
  /** Element or shadow root that should host the overlay canvas (defaults to the video's parent). */
  container?: HTMLElement | ShadowRoot
  /** Existing canvas to render into. Never removed on dispose; Worker OffscreenCanvas requires an explicit backend. */
  canvas?: HTMLCanvasElement
  /** Cap the canvas backing-store pixel ratio while preserving its CSS size. */
  devicePixelRatioCap?: number
  /** Force a present backend instead of using the automatic backend ladder. */
  backend?: SubtitleRendererBackend | 'auto'
  /** URL to the subtitle file. Omit both sources to create a live PGS/DVB push renderer. */
  subUrl?: string
  /** Direct subtitle content (ArrayBuffer). Omit both sources to create a live PGS/DVB push renderer. */
  subContent?: ArrayBuffer
  /** Worker URL (kept for API compatibility, not used in WASM version) */
  workerUrl?: string
  /** Callback when subtitle loading starts */
  onLoading?: () => void
  /** Callback when subtitle loading completes */
  onLoaded?: () => void
  /** Callback when subtitle loading fails */
  onError?: (error: Error) => void
  /** Callback when WebGPU is unavailable and falling back to WebGL2 or Canvas2D */
  onWebGPUFallback?: () => void
  /** Callback when WebGL2 is unavailable and falling back to Canvas2D */
  onWebGL2Fallback?: () => void
  /** Prefer Worker OffscreenCanvas present on the Canvas2D tier (default true) */
  offscreenRender?: boolean
  /** Sync cue selection to presented video-frame mediaTime when supported (default true) */
  frameAwareSync?: boolean
  /** Initial display settings for subtitle layout */
  displaySettings?: Partial<SubtitleDisplaySettings>
  /** Maximum number of rendered frames kept in cache */
  cacheLimit?: number
  /** Prefetch window around the current cue index */
  prefetchWindow?: {
    before?: number
    after?: number
  }
  streamingLoad?: boolean
  rangeRequests?: boolean
  /** Generic observability hook for renderer lifecycle, cache, worker and cue changes */
  onEvent?: (event: SubtitleRendererEvent) => void
  /** Enable richer diagnostics capture for render attempts and warnings */
  debug?: boolean
  /** Callback for structured non-fatal diagnostics warnings */
  onWarning?: (warning: SubtitleDiagnosticWarning) => void
  /** Time offset in seconds added to video.currentTime for subtitle lookup (e.g., for live TV sync) */
  timeOffset?: number
}

/** Options for VobSub video subtitle renderer. */
export interface VideoVobSubOptions extends VideoSubtitleOptions {
  /** URL to the .idx file (optional, defaults to subUrl with .idx extension) */
  idxUrl?: string
  /** Direct .idx content (string) */
  idxContent?: string
  /** Optional file name hint for non-.sub VobSub containers such as .mks */
  fileName?: string
}

/** Display settings for subtitle rendering. */
export interface SubtitleDisplaySettings {
  /** Scale factor for subtitles (1.0 = 100%, 0.5 = 50%, 2.0 = 200%) */
  scale: number
  /** How subtitle track coordinates are mapped into the video content box */
  aspectMode: SubtitleAspectMode
  /** Vertical offset as percentage of video height (-50 to 50, negative = up, positive = down) */
  verticalOffset: number
  /** Horizontal offset as percentage of video width (-50 to 50, negative = left, positive = right) */
  horizontalOffset: number
  /** Horizontal alignment anchor used when scaling subtitle groups */
  horizontalAlign: SubtitleHorizontalAlign
  /** Additional bottom padding as percentage of video height */
  bottomPadding: number
  /** Safe area clamp as percentage of the video dimension */
  safeArea: number
  /** Global subtitle opacity (0.0 - 1.0) */
  opacity: number
}

/** Presentation backend selected by a high-level renderer. */
export type SubtitleRendererBackend = 'webgpu' | 'webgl2' | 'worker-offscreen' | 'canvas2d'

/** Whether cue times follow RVFC or requestAnimationFrame. */
export type SubtitleSynchronizationMode = 'video-frame' | 'animation-frame'

/** Concrete present path used for the last frame. */
export type SubtitlePresentPath = 'main-webgpu' | 'main-webgl2' | 'worker-offscreen' | 'main-canvas2d' | 'main-thread'

/** Probed browser capabilities for rendering backends. */
export interface RuntimeCapabilities {
  worker: boolean
  offscreenCanvas: boolean
  transferControlToOffscreen: boolean
  offscreenCanvas2d: boolean
  workerOffscreenRender: boolean
  webgpu: boolean
  webgl2: boolean
  canvas2d: boolean
  createImageBitmap: boolean
  preferredPresentPath: SubtitlePresentPath
  reasons: string[]
}

/** Observability event emitted by a high-level renderer. */
export type SubtitleRendererEvent =
  | { type: 'loading'; format: SubtitleFormatName }
  | {
      type: 'load-progress'
      format: SubtitleFormatName
      loadedBytes: number
      totalBytes: number | null
      ratio: number | null
      strategy: AssetFetchStrategy
      rangeSupported: boolean
      indexedCues: number
    }
  | { type: 'indexed'; format: SubtitleFormatName; metadata: SubtitleParserMetadata; partial: boolean }
  | { type: 'loaded'; format: SubtitleFormatName; metadata: SubtitleParserMetadata }
  | { type: 'error'; format: SubtitleFormatName; error: SubtitleDiagnosticErrorLike }
  | { type: 'warning'; warning: SubtitleDiagnosticWarning }
  | { type: 'renderer-change'; renderer: SubtitleRendererBackend }
  | { type: 'worker-state'; enabled: boolean; ready: boolean; sessionId: string | null; fallback?: boolean }
  | { type: 'cache-change'; cachedFrames: number; pendingRenders: number; cacheLimit: number }
  | { type: 'cue-change'; cue: SubtitleCueMetadata | null }
  | { type: 'stats'; stats: SubtitleRendererStatsSnapshot }

/** Frame-cache occupancy counters. */
export interface SubtitleCacheStats {
  cacheLimit: number
  cachedFrames: number
  pendingRenders: number
  totalEntries: number
  usingWorker: boolean
  workerReady: boolean
  sessionId: string | null
}

/** Status of the last present attempt. */
export type SubtitleRenderStatus = 'rendered' | 'cleared' | 'pending' | 'empty' | 'failed'

/** Details about the last presented or skipped frame. */
export interface SubtitleLastRenderInfo {
  time: number
  index: number
  status: SubtitleRenderStatus
  backend: SubtitleRendererBackend | null
  usingWorker: boolean
  cacheHit: boolean
  renderDuration: number
  frameWidth: number | null
  frameHeight: number | null
  compositionCount: number
  cue: SubtitleCueMetadata | null
  cache: SubtitleCacheStats
  capturedAt: number
}

/** Renderer stats snapshot including backend and sync mode. */
export interface SubtitleRendererStatsSnapshot {
  framesRendered: number
  framesDropped: number
  avgRenderTime: number
  maxRenderTime: number
  minRenderTime: number
  lastRenderTime: number
  renderFps: number
  usingWorker: boolean
  cachedFrames: number
  pendingRenders: number
  totalEntries: number
  currentIndex: number
  syncMode: SubtitleSynchronizationMode
}

// =============================================================================
// Worker Types
// =============================================================================

/** Legacy alias for a composed image plane. */
export interface CompositionData {
  rgba: Uint8Array
  x: number
  y: number
  width: number
  height: number
}

/** Legacy alias for a composed subtitle frame. */
export interface FrameData {
  width: number
  height: number
  compositions: CompositionData[]
}

/** Metadata describing a worker OffscreenCanvas session. */
export interface WorkerSessionMetadata {
  format: SubtitleFormatName
  cueCount: number
  screenWidth: number
  screenHeight: number
  language?: string
  trackId?: string
  hasIdxMetadata?: boolean
}

/** Display settings forwarded to the worker compositor. */
export interface WorkerOffscreenDisplaySettings {
  scale: number
  aspectMode: SubtitleAspectMode
  verticalOffset: number
  horizontalOffset: number
  horizontalAlign: SubtitleHorizontalAlign
  bottomPadding: number
  safeArea: number
  opacity: number
}

/** Request posted to the libbitsub worker. */
export type WorkerRequest =
  | { type: 'init'; wasmUrl: string; glueUrl?: string }
  | { type: 'loadPgs'; sessionId: string; data: ArrayBuffer }
  | { type: 'beginPgs'; sessionId: string }
  | { type: 'appendPgs'; sessionId: string; data: ArrayBuffer }
  | { type: 'finishPgs'; sessionId: string }
  | { type: 'resetPgs'; sessionId: string }
  | { type: 'loadDvb'; sessionId: string; data: ArrayBuffer }
  | { type: 'beginDvb'; sessionId: string }
  | { type: 'appendDvb'; sessionId: string; data: ArrayBuffer }
  | { type: 'finishDvb'; sessionId: string }
  | { type: 'resetDvb'; sessionId: string }
  | { type: 'loadVobSub'; sessionId: string; idxContent: string; subData: ArrayBuffer }
  | { type: 'loadVobSubIdx'; sessionId: string; idxContent: string }
  | { type: 'attachVobSubData'; sessionId: string; subData: ArrayBuffer }
  | { type: 'loadVobSubMks'; sessionId: string; subData: ArrayBuffer }
  | { type: 'loadVobSubOnly'; sessionId: string; subData: ArrayBuffer }
  | { type: 'renderPgsAtIndex'; sessionId: string; index: number }
  | { type: 'renderDvbAtIndex'; sessionId: string; index: number }
  | { type: 'renderVobSubAtIndex'; sessionId: string; index: number }
  | { type: 'findPgsIndex'; sessionId: string; timeMs: number }
  | { type: 'findDvbIndex'; sessionId: string; timeMs: number }
  | { type: 'findVobSubIndex'; sessionId: string; timeMs: number }
  | { type: 'getPgsTimestamps'; sessionId: string }
  | { type: 'getDvbTimestamps'; sessionId: string }
  | { type: 'getVobSubTimestamps'; sessionId: string }
  | { type: 'clearPgsCache'; sessionId: string }
  | { type: 'clearDvbCache'; sessionId: string }
  | { type: 'clearVobSubCache'; sessionId: string }
  | { type: 'disposePgs'; sessionId: string }
  | { type: 'disposeDvb'; sessionId: string }
  | { type: 'disposeVobSub'; sessionId: string }
  | { type: 'setVobSubDebandEnabled'; sessionId: string; enabled: boolean }
  | { type: 'setVobSubDebandThreshold'; sessionId: string; threshold: number }
  | { type: 'setVobSubDebandRange'; sessionId: string; range: number }
  | { type: 'attachOffscreenCanvas'; sessionId: string; canvas: OffscreenCanvas }
  | { type: 'resizeOffscreenCanvas'; sessionId: string; width: number; height: number }
  | { type: 'detachOffscreenCanvas'; sessionId: string }
  | { type: 'clearOffscreenCanvas'; sessionId: string }
  | {
      type: 'presentOffscreen'
      sessionId: string
      format: SubtitleFormatName
      index: number
      canvasWidth: number
      canvasHeight: number
      displaySettings: WorkerOffscreenDisplaySettings
    }

/** Present status reported by the worker compositor. */
export type WorkerOffscreenPresentStatus = 'rendered' | 'cleared' | 'empty' | 'failed'

/** Response posted from the libbitsub worker. */
export type WorkerResponse =
  | { type: 'initComplete'; success: boolean; error?: string }
  | { type: 'pgsLoaded'; count: number; byteLength: number; metadata: WorkerSessionMetadata; timestamps: Float64Array }
  | {
      type: 'pgsProgress'
      count: number
      added: number
      partial: boolean
      metadata: WorkerSessionMetadata
      timestamps: Float64Array
    }
  | {
      type: 'dvbLoaded'
      count: number
      byteLength: number
      metadata: WorkerSessionMetadata
      timestamps: Float64Array
      endTimestamps: Float64Array
    }
  | {
      type: 'dvbProgress'
      count: number
      added: number
      partial: boolean
      metadata: WorkerSessionMetadata
      timestamps: Float64Array
      endTimestamps: Float64Array
    }
  | { type: 'vobSubLoaded'; count: number; metadata: WorkerSessionMetadata; timestamps: Float64Array }
  | {
      type: 'vobSubProgress'
      count: number
      partial: boolean
      hasSubData: boolean
      metadata: WorkerSessionMetadata
      timestamps: Float64Array
    }
  | { type: 'pgsFrame'; frame: FrameData | null; renderIssue?: string }
  | { type: 'dvbFrame'; frame: FrameData | null; renderIssue?: string }
  | { type: 'vobSubFrame'; frame: FrameData | null; renderIssue?: string }
  | { type: 'pgsIndex'; index: number }
  | { type: 'dvbIndex'; index: number }
  | { type: 'vobSubIndex'; index: number }
  | { type: 'pgsTimestamps'; timestamps: Float64Array }
  | { type: 'dvbTimestamps'; timestamps: Float64Array }
  | { type: 'vobSubTimestamps'; timestamps: Float64Array }
  | { type: 'cleared' }
  | { type: 'disposed' }
  | { type: 'debandSet' }
  | { type: 'offscreenAttached' }
  | { type: 'offscreenResized' }
  | { type: 'offscreenDetached' }
  | { type: 'offscreenCleared' }
  | {
      type: 'offscreenPresented'
      status: WorkerOffscreenPresentStatus
      /** True only when the worker presentation infrastructure is unusable. */
      fatal?: boolean
      renderIssue?: string
      width?: number
      height?: number
      compositionCount?: number
      bounds?: SubtitleCueBounds | null
    }
  | { type: 'error'; message: string }

/** Shared worker state for video renderers. */
export interface WorkerRendererState {
  useWorker: boolean
  workerReady: boolean
  sessionId: string | null
  timestamps: Float64Array
  frameCache: Map<number, SubtitleData | null>
  renderIssues: Map<number, string | null>
  pendingRenders: Map<number, Promise<SubtitleData | null>>
  cacheLimit: number
  metadata: SubtitleParserMetadata | null
}

/** Source fields used by createAutoSubtitleRenderer(). */
export interface AutoSubtitleSource {
  data?: ArrayBuffer | Uint8Array
  subData?: ArrayBuffer | Uint8Array
  idxContent?: string
  fileName?: string
  subUrl?: string
  idxUrl?: string
}

/** Options for auto-detecting PGS/VobSub/DVB input. */
export interface AutoVideoSubtitleOptions extends Omit<VideoVobSubOptions, 'subUrl' | 'idxUrl'> {
  subUrl?: string
  idxUrl?: string
  fileName?: string
}
