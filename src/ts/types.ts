/**
 * Type definitions for libbitsub TypeScript wrapper.
 */

import type {
  SubtitleRenderer as WasmSubtitleRenderer,
  PgsParser as WasmPgsParser,
  VobSubParser as WasmVobSubParser,
  RenderResult,
  SubtitleFrame,
  VobSubFrame
} from '../../pkg/libbitsub'

// Re-export WASM types
export type { WasmSubtitleRenderer, WasmPgsParser, WasmVobSubParser, RenderResult, SubtitleFrame, VobSubFrame }

export type SubtitleFormatName = 'pgs' | 'vobsub'

export type SubtitleHorizontalAlign = 'left' | 'center' | 'right'

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

/** A single composition element. */
export interface SubtitleCompositionData {
  /** The compiled pixel data of the subtitle. */
  pixelData: ImageData
  /** X position on screen. */
  x: number
  /** Y position on screen. */
  y: number
}

export interface SubtitleCueBounds {
  x: number
  y: number
  width: number
  height: number
}

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

export interface SubtitleParserMetadata {
  format: SubtitleFormatName
  cueCount: number
  screenWidth: number
  screenHeight: number
  language?: string | null
  trackId?: string | null
  hasIdxMetadata?: boolean
}

// =============================================================================
// Video Renderer Options
// =============================================================================

/** Options for video subtitle renderers. */
export interface VideoSubtitleOptions {
  /** The video element to sync with */
  video: HTMLVideoElement
  /** URL to the subtitle file */
  subUrl?: string
  /** Direct subtitle content (ArrayBuffer) */
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
  /** Initial display settings for subtitle layout */
  displaySettings?: Partial<SubtitleDisplaySettings>
  /** Maximum number of rendered frames kept in cache */
  cacheLimit?: number
  /** Prefetch window around the current cue index */
  prefetchWindow?: {
    before?: number
    after?: number
  }
  /** Generic observability hook for renderer lifecycle, cache, worker and cue changes */
  onEvent?: (event: SubtitleRendererEvent) => void
  /** Time offset in seconds added to video.currentTime for subtitle lookup (e.g., for live TV sync) */
  timeOffset?: number
}

/** Options for VobSub video subtitle renderer. */
export interface VideoVobSubOptions extends VideoSubtitleOptions {
  /** URL to the .idx file (optional, defaults to subUrl with .idx extension) */
  idxUrl?: string
  /** Direct .idx content (string) */
  idxContent?: string
}

/** Display settings for subtitle rendering. */
export interface SubtitleDisplaySettings {
  /** Scale factor for subtitles (1.0 = 100%, 0.5 = 50%, 2.0 = 200%) */
  scale: number
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

export type SubtitleRendererBackend = 'webgpu' | 'webgl2' | 'canvas2d'

export type SubtitleRendererEvent =
  | { type: 'loading'; format: SubtitleFormatName }
  | { type: 'loaded'; format: SubtitleFormatName; metadata: SubtitleParserMetadata }
  | { type: 'error'; format: SubtitleFormatName; error: Error }
  | { type: 'renderer-change'; renderer: SubtitleRendererBackend }
  | { type: 'worker-state'; enabled: boolean; ready: boolean; sessionId: string | null; fallback?: boolean }
  | { type: 'cache-change'; cachedFrames: number; pendingRenders: number; cacheLimit: number }
  | { type: 'cue-change'; cue: SubtitleCueMetadata | null }
  | { type: 'stats'; stats: SubtitleRendererStatsSnapshot }

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
}

// =============================================================================
// Worker Types
// =============================================================================

export interface CompositionData {
  rgba: Uint8Array
  x: number
  y: number
  width: number
  height: number
}

export interface FrameData {
  width: number
  height: number
  compositions: CompositionData[]
}

export interface WorkerSessionMetadata {
  format: SubtitleFormatName
  cueCount: number
  screenWidth: number
  screenHeight: number
  language?: string
  trackId?: string
  hasIdxMetadata?: boolean
}

export type WorkerRequest =
  | { type: 'init'; wasmUrl: string }
  | { type: 'loadPgs'; sessionId: string; data: ArrayBuffer }
  | { type: 'loadVobSub'; sessionId: string; idxContent: string; subData: ArrayBuffer }
  | { type: 'loadVobSubOnly'; sessionId: string; subData: ArrayBuffer }
  | { type: 'renderPgsAtIndex'; sessionId: string; index: number }
  | { type: 'renderVobSubAtIndex'; sessionId: string; index: number }
  | { type: 'findPgsIndex'; sessionId: string; timeMs: number }
  | { type: 'findVobSubIndex'; sessionId: string; timeMs: number }
  | { type: 'getPgsTimestamps'; sessionId: string }
  | { type: 'getVobSubTimestamps'; sessionId: string }
  | { type: 'clearPgsCache'; sessionId: string }
  | { type: 'clearVobSubCache'; sessionId: string }
  | { type: 'disposePgs'; sessionId: string }
  | { type: 'disposeVobSub'; sessionId: string }
  | { type: 'setVobSubDebandEnabled'; sessionId: string; enabled: boolean }
  | { type: 'setVobSubDebandThreshold'; sessionId: string; threshold: number }
  | { type: 'setVobSubDebandRange'; sessionId: string; range: number }

export type WorkerResponse =
  | { type: 'initComplete'; success: boolean; error?: string }
  | { type: 'pgsLoaded'; count: number; byteLength: number; metadata: WorkerSessionMetadata }
  | { type: 'vobSubLoaded'; count: number; metadata: WorkerSessionMetadata }
  | { type: 'pgsFrame'; frame: FrameData | null }
  | { type: 'vobSubFrame'; frame: FrameData | null }
  | { type: 'pgsIndex'; index: number }
  | { type: 'vobSubIndex'; index: number }
  | { type: 'pgsTimestamps'; timestamps: Float64Array }
  | { type: 'vobSubTimestamps'; timestamps: Float64Array }
  | { type: 'cleared' }
  | { type: 'disposed' }
  | { type: 'debandSet' }
  | { type: 'error'; message: string }

/** Shared worker state for video renderers. */
export interface WorkerRendererState {
  useWorker: boolean
  workerReady: boolean
  sessionId: string | null
  timestamps: Float64Array
  frameCache: Map<number, SubtitleData | null>
  pendingRenders: Map<number, Promise<SubtitleData | null>>
  cacheLimit: number
  metadata: SubtitleParserMetadata | null
}

export interface AutoSubtitleSource {
  data?: ArrayBuffer | Uint8Array
  subData?: ArrayBuffer | Uint8Array
  idxContent?: string
  fileName?: string
  subUrl?: string
  idxUrl?: string
}

export interface AutoVideoSubtitleOptions extends Omit<VideoVobSubOptions, 'subUrl' | 'idxUrl'> {
  subUrl?: string
  idxUrl?: string
  fileName?: string
}
