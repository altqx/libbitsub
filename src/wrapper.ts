/**
 * TypeScript wrapper for the libbitsub Rust rendering engine.
 * Provides a compatible API with the original libpgs-js implementation.
 */

// Re-export all types
export type {
  AutoSubtitleSource,
  AutoVideoSubtitleOptions,
  OpenedSubtitles,
  SubtitleAspectMode,
  SubtitleCacheStats,
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
  VideoSubtitleOptions,
  VideoVobSubOptions,
  RenderResult,
  SubtitleFrame,
  VobSubFrame
} from './ts/types'

export { SubtitleDiagnosticError, createSubtitleDiagnosticError, normalizeSubtitleError } from './ts/diagnostics'

// Re-export WASM management
export { initWasm, isWasmInitialized } from './ts/wasm'

// Re-export WebGPU utilities
export { isWebGPUSupported } from './ts/webgpu-renderer'

// Re-export parsers
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser, openSubtitles } from './ts/parsers'

// Re-export frame export helpers
export { renderFrameData, toBlob, toCanvas, toImageBitmap } from './ts/frame-export'

// Re-export renderers
export { PgsRenderer, VobSubRenderer, createAutoSubtitleRenderer, type SubtitleRendererStats } from './ts/renderers'

// Re-export format detection utilities
export { detectSubtitleFormat } from './ts/utils'

// =============================================================================
// Legacy Aliases (for backward compatibility)
// =============================================================================

import { PgsRenderer as _PgsRenderer, VobSubRenderer as _VobSubRenderer } from './ts/renderers'
import { UnifiedSubtitleParser as _UnifiedSubtitleParser } from './ts/parsers'

/** @deprecated Use PgsRenderer instead */
export const PGSRenderer = _PgsRenderer

/** @deprecated Use VobSubRenderer instead */
export const VobsubRenderer = _VobSubRenderer

/** @deprecated Use UnifiedSubtitleParser instead */
export const UnifiedSubtitleRenderer = _UnifiedSubtitleParser
