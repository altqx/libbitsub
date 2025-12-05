/**
 * libbitsub - High-performance WASM renderer for graphical subtitles
 * 
 * @packageDocumentation
 */

export {
    initWasm,
    isWasmInitialized,
    PgsRenderer,
    VobSubRenderer,
    UnifiedSubtitleRenderer,
    type SubtitleData,
    type SubtitleCompositionData,
} from './wrapper';

// Re-export WASM types for advanced usage
export type {
    RenderResult,
    SubtitleFrame,
    VobSubFrame,
} from '../pkg/libbitsub';
