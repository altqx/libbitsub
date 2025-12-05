/**
 * libbitsub - High-performance WASM renderer for graphical subtitles
 *
 * @packageDocumentation
 */

// High-level video-integrated renderers (compatible with old libpgs-js API)
export { PgsRenderer, VobSubRenderer, type VideoSubtitleOptions, type VideoVobSubOptions, type SubtitleRendererStats } from './wrapper'

// Low-level parsers for programmatic use
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser } from './wrapper'

// Utility exports
export {
  initWasm,
  isWasmInitialized,
  type SubtitleData,
  type SubtitleCompositionData,
  type SubtitleDisplaySettings
} from './wrapper'

// WASM types
export type { RenderResult, SubtitleFrame, VobSubFrame } from './wrapper'

// Legacy aliases
export { PGSRenderer, VobsubRenderer, UnifiedSubtitleRenderer } from './wrapper'
