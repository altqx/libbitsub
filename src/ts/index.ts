/**
 * libbitsub TypeScript modules barrel export.
 */

// Types
export type {
  AutoSubtitleSource,
  SubtitleAspectMode,
  SubtitleCacheStats,
  AutoVideoSubtitleOptions,
  SubtitleCueBounds,
  SubtitleCueMetadata,
  SubtitleData,
  SubtitleDiagnosticDetailValue,
  SubtitleDiagnosticErrorCode,
  SubtitleDiagnosticErrorLike,
  SubtitleDiagnosticsOptions,
  SubtitleDiagnosticWarning,
  SubtitleDiagnosticWarningCode,
  SubtitleCompositionData,
  SubtitleDisplaySettings,
  SubtitleFormatName,
  SubtitleHorizontalAlign,
  SubtitleLastRenderInfo,
  SubtitleParserMetadata,
  SubtitleRendererBackend,
  SubtitleRendererEvent,
  SubtitleRendererStatsSnapshot,
  VideoSubtitleOptions,
  VideoVobSubOptions,
  CompositionData,
  FrameData,
  WorkerRequest,
  WorkerResponse,
  WorkerRendererState,
  RenderResult,
  SubtitleFrame,
  VobSubFrame
} from './types'

export { SubtitleDiagnosticError, createSubtitleDiagnosticError, normalizeSubtitleError } from './diagnostics'

// WASM management
export { initWasm, isWasmInitialized, getWasm, getWasmUrl } from './wasm'

// Worker management
export { isWorkerAvailable, getOrCreateWorker, sendToWorker } from './worker'

// Utilities
export {
  binarySearchTimestamp,
  convertFrameData,
  createWorkerState,
  createWorkerSessionId,
  detectSubtitleFormat,
  getSubtitleBounds,
  setCacheLimit,
  setCachedFrame
} from './utils'

// Parsers
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser } from './parsers'

// Renderers
export { PgsRenderer, VobSubRenderer, createAutoSubtitleRenderer } from './renderers'

// GPU renderers (advanced use)
export { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer'
export { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'
