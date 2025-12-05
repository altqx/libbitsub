//! High-level renderer that handles both PGS and VobSub formats.
//!
//! This module provides a unified interface for subtitle rendering.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

use crate::pgs::PgsParser;
use crate::vobsub::VobSubParser;

/// Subtitle format type.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleFormat {
    /// PGS (Blu-ray) subtitle format
    Pgs = 0,
    /// VobSub (DVD) subtitle format
    VobSub = 1,
}

/// Unified subtitle renderer for both PGS and VobSub formats.
#[wasm_bindgen]
pub struct SubtitleRenderer {
    pgs_parser: Option<PgsParser>,
    vobsub_parser: Option<VobSubParser>,
    format: Option<SubtitleFormat>,
}

#[wasm_bindgen]
impl SubtitleRenderer {
    /// Create a new subtitle renderer.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            pgs_parser: None,
            vobsub_parser: None,
            format: None,
        }
    }

    /// Load PGS subtitle data.
    #[wasm_bindgen(js_name = loadPgs)]
    pub fn load_pgs(&mut self, data: &[u8]) -> usize {
        self.dispose();

        let mut parser = PgsParser::new();
        let count = parser.parse(data);

        self.pgs_parser = Some(parser);
        self.format = Some(SubtitleFormat::Pgs);

        count
    }

    /// Load VobSub subtitle data from IDX and SUB.
    #[wasm_bindgen(js_name = loadVobSub)]
    pub fn load_vobsub(&mut self, idx_content: &str, sub_data: &[u8]) {
        self.dispose();

        let mut parser = VobSubParser::new();
        parser.load_from_data(idx_content, sub_data);

        self.vobsub_parser = Some(parser);
        self.format = Some(SubtitleFormat::VobSub);
    }

    /// Load VobSub from SUB file only.
    #[wasm_bindgen(js_name = loadVobSubOnly)]
    pub fn load_vobsub_only(&mut self, sub_data: &[u8]) {
        self.dispose();

        let mut parser = VobSubParser::new();
        parser.load_from_sub_only(sub_data);

        self.vobsub_parser = Some(parser);
        self.format = Some(SubtitleFormat::VobSub);
    }

    /// Get the current subtitle format.
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> Option<SubtitleFormat> {
        self.format
    }

    /// Get the number of subtitle entries.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        match self.format {
            Some(SubtitleFormat::Pgs) => self.pgs_parser.as_ref().map_or(0, |p| p.count()),
            Some(SubtitleFormat::VobSub) => self.vobsub_parser.as_ref().map_or(0, |p| p.count()),
            None => 0,
        }
    }

    /// Get all timestamps in milliseconds.
    #[wasm_bindgen(js_name = getTimestamps)]
    pub fn get_timestamps(&self) -> js_sys::Float64Array {
        match self.format {
            Some(SubtitleFormat::Pgs) => self.pgs_parser.as_ref().map_or_else(
                || js_sys::Float64Array::new_with_length(0),
                |p| p.get_timestamps(),
            ),
            Some(SubtitleFormat::VobSub) => self.vobsub_parser.as_ref().map_or_else(
                || js_sys::Float64Array::new_with_length(0),
                |p| p.get_timestamps(),
            ),
            None => js_sys::Float64Array::new_with_length(0),
        }
    }

    /// Find the subtitle index for a given timestamp in milliseconds.
    #[wasm_bindgen(js_name = findIndexAtTimestamp)]
    pub fn find_index_at_timestamp(&mut self, time_ms: f64) -> i32 {
        match self.format {
            Some(SubtitleFormat::Pgs) => self
                .pgs_parser
                .as_ref()
                .map_or(-1, |p| p.find_index_at_timestamp(time_ms)),
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_mut()
                .map_or(-1, |p| p.find_index_at_timestamp(time_ms)),
            None => -1,
        }
    }

    /// Render subtitle at the given index.
    /// Returns a unified RenderResult or null.
    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<RenderResult> {
        match self.format {
            Some(SubtitleFormat::Pgs) => {
                let parser = self.pgs_parser.as_mut()?;
                let frame = parser.render_at_index(index)?;

                // Convert to unified format
                let mut compositions = Vec::new();
                for i in 0..frame.composition_count() {
                    if let Some(comp) = frame.get_composition(i) {
                        compositions.push(RenderComposition {
                            x: comp.x(),
                            y: comp.y(),
                            width: comp.width(),
                            height: comp.height(),
                            rgba: comp.get_rgba().to_vec(),
                        });
                    }
                }

                Some(RenderResult {
                    screen_width: frame.width(),
                    screen_height: frame.height(),
                    compositions,
                })
            }
            Some(SubtitleFormat::VobSub) => {
                let parser = self.vobsub_parser.as_mut()?;
                let frame = parser.render_at_index(index)?;

                Some(RenderResult {
                    screen_width: frame.screen_width(),
                    screen_height: frame.screen_height(),
                    compositions: vec![RenderComposition {
                        x: frame.x(),
                        y: frame.y(),
                        width: frame.width(),
                        height: frame.height(),
                        rgba: frame.get_rgba().to_vec(),
                    }],
                })
            }
            None => None,
        }
    }

    /// Render subtitle at the given timestamp in seconds.
    #[wasm_bindgen(js_name = renderAtTimestamp)]
    pub fn render_at_timestamp(&mut self, time_seconds: f64) -> Option<RenderResult> {
        let time_ms = time_seconds * 1000.0;
        let index = self.find_index_at_timestamp(time_ms);
        if index < 0 {
            return None;
        }
        self.render_at_index(index as usize)
    }

    /// Clear internal caches.
    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        if let Some(ref mut parser) = self.pgs_parser {
            parser.clear_cache();
        }
        if let Some(ref mut parser) = self.vobsub_parser {
            parser.clear_cache();
        }
    }

    /// Dispose of all resources.
    #[wasm_bindgen]
    pub fn dispose(&mut self) {
        self.pgs_parser = None;
        self.vobsub_parser = None;
        self.format = None;
    }
}

impl Default for SubtitleRenderer {
    fn default() -> Self {
        Self::new()
    }
}

/// A single composition element in the render result.
struct RenderComposition {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    rgba: Vec<u8>,
}

/// Unified render result for both formats.
#[wasm_bindgen]
pub struct RenderResult {
    screen_width: u16,
    screen_height: u16,
    compositions: Vec<RenderComposition>,
}

#[wasm_bindgen]
impl RenderResult {
    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.screen_width
    }

    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.screen_height
    }

    /// Get the number of composition elements.
    #[wasm_bindgen(getter, js_name = compositionCount)]
    pub fn composition_count(&self) -> usize {
        self.compositions.len()
    }

    /// Get composition X position at index.
    #[wasm_bindgen(js_name = getCompositionX)]
    pub fn get_composition_x(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.x)
    }

    /// Get composition Y position at index.
    #[wasm_bindgen(js_name = getCompositionY)]
    pub fn get_composition_y(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.y)
    }

    /// Get composition width at index.
    #[wasm_bindgen(js_name = getCompositionWidth)]
    pub fn get_composition_width(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.width)
    }

    /// Get composition height at index.
    #[wasm_bindgen(js_name = getCompositionHeight)]
    pub fn get_composition_height(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.height)
    }

    /// Get composition RGBA data at index.
    #[wasm_bindgen(js_name = getCompositionRgba)]
    pub fn get_composition_rgba(&self, index: usize) -> Uint8Array {
        self.compositions.get(index).map_or_else(
            || Uint8Array::new_with_length(0),
            |c| Uint8Array::from(&c.rgba[..]),
        )
    }
}
