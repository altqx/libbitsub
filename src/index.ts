/**
 * libbitsub - High-performance WASM renderer for graphical subtitles
 *
 * @packageDocumentation
 */

// High-level video-integrated renderers (compatible with old libpgs-js API)
export {
  PgsRenderer,
  VobSubRenderer,
  createAutoSubtitleRenderer,
  type VideoSubtitleOptions,
  type VideoVobSubOptions,
  type SubtitleRendererStats
} from './wrapper'

// Low-level parsers for programmatic use
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser } from './wrapper'

// Utility exports
export {
  initWasm,
  isWasmInitialized,
  isWebGPUSupported,
  detectSubtitleFormat,
  renderFrameData,
  toBlob,
  toCanvas,
  toImageBitmap,
  createSubtitleDiagnosticError,
  normalizeSubtitleError,
  SubtitleDiagnosticError,
  type AutoSubtitleSource,
  type AutoVideoSubtitleOptions,
  type SubtitleAspectMode,
  type SubtitleCacheStats,
  type SubtitleCueBounds,
  type SubtitleCueMetadata,
  type SubtitleData,
  type SubtitleDiagnosticDetailValue,
  type SubtitleDiagnosticErrorCode,
  type SubtitleDiagnosticErrorLike,
  type SubtitleDiagnosticsOptions,
  type SubtitleDiagnosticWarning,
  type SubtitleDiagnosticWarningCode,
  type SubtitleCompositionData,
  type SubtitleDisplaySettings,
  type SubtitleFrameCanvasOptions,
  type SubtitleFrameCanvasTarget,
  type SubtitleFrameCropMode,
  type SubtitleFrameRenderOptions,
  type SubtitleRenderedFrameData,
  type SubtitleFormatName,
  type SubtitleHorizontalAlign,
  type SubtitleLastRenderInfo,
  type SubtitleParserMetadata,
  type SubtitleRendererBackend,
  type SubtitleRendererEvent,
  type SubtitleRendererStatsSnapshot
} from './wrapper'

// WASM types
export type { RenderResult, SubtitleFrame, VobSubFrame } from './wrapper'

// Legacy aliases
export { PGSRenderer, VobsubRenderer, UnifiedSubtitleRenderer } from './wrapper'
