/**
 * libbitsub TypeScript modules barrel export.
 */

// Types
export type {
  AssetFetchStrategy,
  AutoSubtitleSource,
  OpenedSubtitles,
  SubtitleAspectMode,
  SubtitleCacheStats,
  AutoVideoSubtitleOptions,
  SubtitleFrameCanvasOptions,
  SubtitleFrameCanvasTarget,
  SubtitleFrameCropMode,
  SubtitleFrameRenderOptions,
  SubtitleRenderedFrameData,
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
  RuntimeCapabilities,
  SubtitlePresentPath,
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
export { initWasm, isWasmInitialized, getWasm, getWasmUrl, getWasmGlueUrl } from './wasm'

// Worker management
export { isWorkerAvailable, isWorkerReady, getOrCreateWorker, sendToWorker, warmup, ready } from './worker'

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

export {
  fetchSubtitleAsset,
  fetchSubtitleText,
  probeRangeSupport,
  type AssetFetchOptions,
  type AssetFetchProgress,
  type RangeProbeResult
} from './range-loader'

// Frame export helpers
export { renderFrameData, toBlob, toCanvas, toImageBitmap } from './frame-export'

// Parsers
export { PgsParser, DvbParser, VobSubParserLowLevel, UnifiedSubtitleParser, openSubtitles } from './parsers'

// Renderers
export { PgsRenderer, DvbRenderer, VobSubRenderer, createAutoSubtitleRenderer } from './renderers'

// GPU renderers (advanced use)
export { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer'
export { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer'

export {
  getRuntimeCapabilities,
  canUseWorkerOffscreenRender,
  isOffscreenCanvasSupported,
  isOffscreenCanvas2DSupported,
  isTransferControlToOffscreenSupported,
  isCanvas2DSupported
} from './capabilities'
