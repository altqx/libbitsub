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
  type AutoSubtitleSource,
  type AutoVideoSubtitleOptions,
  type SubtitleCueBounds,
  type SubtitleCueMetadata,
  type SubtitleData,
  type SubtitleCompositionData,
  type SubtitleDisplaySettings,
  type SubtitleFormatName,
  type SubtitleHorizontalAlign,
  type SubtitleParserMetadata,
  type SubtitleRendererBackend,
  type SubtitleRendererEvent,
  type SubtitleRendererStatsSnapshot
} from './wrapper'

// WASM types
export type { RenderResult, SubtitleFrame, VobSubFrame } from './wrapper'

// Legacy aliases
export { PGSRenderer, VobsubRenderer, UnifiedSubtitleRenderer } from './wrapper'
