/**
 * TypeScript wrapper for the libbitsub Rust rendering engine.
 * Provides a compatible API with the original libpgs-js implementation.
 */

// Re-export all types
export type {
  SubtitleData,
  SubtitleCompositionData,
  SubtitleDisplaySettings,
  VideoSubtitleOptions,
  VideoVobSubOptions,
  RenderResult,
  SubtitleFrame,
  VobSubFrame
} from './ts/types'

// Re-export WASM management
export { initWasm, isWasmInitialized } from './ts/wasm'

// Re-export parsers
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser } from './ts/parsers'

// Re-export renderers
export { PgsRenderer, VobSubRenderer, type SubtitleRendererStats } from './ts/renderers'

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
