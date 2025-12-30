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

// =============================================================================
// Video Renderer Options
// =============================================================================

/** Options for video subtitle renderers. */
export interface VideoSubtitleOptions {
  /** The video element to sync with */
  video: HTMLVideoElement
  /** URL to the subtitle file */
  subUrl: string
  /** Worker URL (kept for API compatibility, not used in WASM version) */
  workerUrl?: string
  /** Prefer WebGPU renderer if available (default: true) */
  preferWebGPU?: boolean
  /** Callback when subtitle loading starts */
  onLoading?: () => void
  /** Callback when subtitle loading completes */
  onLoaded?: () => void
  /** Callback when subtitle loading fails */
  onError?: (error: Error) => void
  /** Callback when WebGPU is unavailable and falling back to Canvas2D */
  onWebGPUFallback?: () => void
}

/** Options for VobSub video subtitle renderer. */
export interface VideoVobSubOptions extends VideoSubtitleOptions {
  /** URL to the .idx file (optional, defaults to subUrl with .idx extension) */
  idxUrl?: string
}

/** Display settings for subtitle rendering. */
export interface SubtitleDisplaySettings {
  /** Scale factor for subtitles (1.0 = 100%, 0.5 = 50%, 2.0 = 200%) */
  scale: number
  /** Vertical offset as percentage of video height (-50 to 50, negative = up, positive = down) */
  verticalOffset: number
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

export type WorkerRequest =
  | { type: 'init'; wasmUrl: string }
  | { type: 'loadPgs'; data: ArrayBuffer }
  | { type: 'loadVobSub'; idxContent: string; subData: ArrayBuffer }
  | { type: 'loadVobSubOnly'; subData: ArrayBuffer }
  | { type: 'renderPgsAtIndex'; index: number }
  | { type: 'renderVobSubAtIndex'; index: number }
  | { type: 'findPgsIndex'; timeMs: number }
  | { type: 'findVobSubIndex'; timeMs: number }
  | { type: 'getPgsTimestamps' }
  | { type: 'getVobSubTimestamps' }
  | { type: 'clearPgsCache' }
  | { type: 'clearVobSubCache' }
  | { type: 'disposePgs' }
  | { type: 'disposeVobSub' }

export type WorkerResponse =
  | { type: 'initComplete'; success: boolean; error?: string }
  | { type: 'pgsLoaded'; count: number; byteLength: number }
  | { type: 'vobSubLoaded'; count: number }
  | { type: 'pgsFrame'; frame: FrameData | null }
  | { type: 'vobSubFrame'; frame: FrameData | null }
  | { type: 'pgsIndex'; index: number }
  | { type: 'vobSubIndex'; index: number }
  | { type: 'pgsTimestamps'; timestamps: Float64Array }
  | { type: 'vobSubTimestamps'; timestamps: Float64Array }
  | { type: 'cleared' }
  | { type: 'disposed' }
  | { type: 'error'; message: string }

/** Shared worker state for video renderers. */
export interface WorkerRendererState {
  useWorker: boolean
  workerReady: boolean
  timestamps: Float64Array
  frameCache: Map<number, SubtitleData | null>
  pendingRenders: Map<number, Promise<SubtitleData | null>>
}
