//! WASM bindings for libbitsub.

use js_sys::{Float64Array, Uint8Array};
use libbitsub_core as core;
use wasm_bindgen::prelude::*;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

/// Initialize the WASM module. Call this once before using other functions.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

fn timestamps_to_array(timestamps: Vec<f64>) -> Float64Array {
    let arr = Float64Array::new_with_length(timestamps.len() as u32);
    for (index, timestamp) in timestamps.into_iter().enumerate() {
        arr.set_index(index as u32, timestamp);
    }
    arr
}

/// PGS subtitle parser and renderer exposed to JavaScript.
#[wasm_bindgen]
pub struct PgsParser {
    inner: core::PgsParser,
}

#[wasm_bindgen]
impl PgsParser {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: core::PgsParser::new(),
        }
    }

    pub fn parse(&mut self, data: &[u8]) -> usize {
        self.inner.parse(data)
    }

    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.inner.count()
    }

    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.inner.screen_width()
    }

    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.inner.screen_height()
    }

    #[wasm_bindgen(js_name = getTimestamps)]
    pub fn get_timestamps(&self) -> Float64Array {
        timestamps_to_array(self.inner.get_timestamps())
    }

    #[wasm_bindgen(js_name = findIndexAtTimestamp)]
    pub fn find_index_at_timestamp(&self, time_ms: f64) -> i32 {
        self.inner.find_index_at_timestamp(time_ms)
    }

    #[wasm_bindgen(js_name = getCueStartTime)]
    pub fn get_cue_start_time(&self, index: usize) -> f64 {
        self.inner.get_cue_start_time(index)
    }

    #[wasm_bindgen(js_name = getCueEndTime)]
    pub fn get_cue_end_time(&self, index: usize) -> f64 {
        self.inner.get_cue_end_time(index)
    }

    #[wasm_bindgen(js_name = getCueCompositionCount)]
    pub fn get_cue_composition_count(&self, index: usize) -> u32 {
        self.inner.get_cue_composition_count(index)
    }

    #[wasm_bindgen(js_name = getCuePaletteId)]
    pub fn get_cue_palette_id(&self, index: usize) -> i32 {
        self.inner.get_cue_palette_id(index)
    }

    #[wasm_bindgen(js_name = getCueCompositionState)]
    pub fn get_cue_composition_state(&self, index: usize) -> i32 {
        self.inner.get_cue_composition_state(index)
    }

    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<SubtitleFrame> {
        self.inner
            .render_at_index(index)
            .map(|inner| SubtitleFrame { inner })
    }

    #[wasm_bindgen(getter, js_name = lastRenderIssue)]
    pub fn last_render_issue(&self) -> String {
        self.inner.last_render_issue()
    }

    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        self.inner.clear_cache();
    }
}

impl Default for PgsParser {
    fn default() -> Self {
        Self::new()
    }
}

/// A single PGS subtitle composition element.
#[wasm_bindgen]
#[derive(Clone)]
pub struct SubtitleComposition {
    inner: core::SubtitleComposition,
}

#[wasm_bindgen]
impl SubtitleComposition {
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> u16 {
        self.inner.x
    }

    #[wasm_bindgen(getter)]
    pub fn y(&self) -> u16 {
        self.inner.y
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u16 {
        self.inner.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u16 {
        self.inner.height
    }

    #[wasm_bindgen(js_name = getRgba)]
    pub fn get_rgba(&self) -> Uint8Array {
        Uint8Array::from(self.inner.get_rgba())
    }
}

/// A complete PGS subtitle frame with all compositions.
#[wasm_bindgen]
pub struct SubtitleFrame {
    inner: core::SubtitleFrame,
}

#[wasm_bindgen]
impl SubtitleFrame {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u16 {
        self.inner.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u16 {
        self.inner.height
    }

    #[wasm_bindgen(getter, js_name = compositionCount)]
    pub fn composition_count(&self) -> usize {
        self.inner.composition_count()
    }

    #[wasm_bindgen(js_name = getComposition)]
    pub fn get_composition(&self, index: usize) -> Option<SubtitleComposition> {
        self.inner
            .get_composition(index)
            .map(|inner| SubtitleComposition { inner })
    }
}

/// VobSub subtitle parser and renderer exposed to JavaScript.
#[wasm_bindgen]
pub struct VobSubParser {
    inner: core::VobSubParser,
}

#[wasm_bindgen]
impl VobSubParser {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: core::VobSubParser::new(),
        }
    }

    #[wasm_bindgen(js_name = loadFromData)]
    pub fn load_from_data(&mut self, idx_content: &str, sub_data: Vec<u8>) {
        self.inner.load_from_data(idx_content, sub_data);
    }

    #[wasm_bindgen(js_name = loadFromMks)]
    pub fn load_from_mks(&mut self, mks_data: &[u8]) -> Result<(), JsValue> {
        self.inner
            .load_from_mks(mks_data)
            .map_err(|error| JsValue::from_str(&error))
    }

    #[wasm_bindgen(js_name = loadFromSubOnly)]
    pub fn load_from_sub_only(&mut self, sub_data: Vec<u8>) {
        self.inner.load_from_sub_only(sub_data);
    }

    pub fn dispose(&mut self) {
        self.inner.dispose();
    }

    #[wasm_bindgen(getter, js_name = lastRenderIssue)]
    pub fn last_render_issue(&self) -> String {
        self.inner.last_render_issue()
    }

    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.inner.count()
    }

    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.inner.screen_width()
    }

    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.inner.screen_height()
    }

    #[wasm_bindgen(getter)]
    pub fn language(&self) -> String {
        self.inner.language()
    }

    #[wasm_bindgen(getter, js_name = trackId)]
    pub fn track_id(&self) -> String {
        self.inner.track_id()
    }

    #[wasm_bindgen(getter, js_name = hasIdxMetadata)]
    pub fn has_idx_metadata(&self) -> bool {
        self.inner.has_idx_metadata()
    }

    #[wasm_bindgen(js_name = getTimestamps)]
    pub fn get_timestamps(&self) -> Float64Array {
        timestamps_to_array(self.inner.get_timestamps())
    }

    #[wasm_bindgen(js_name = findIndexAtTimestamp)]
    pub fn find_index_at_timestamp(&mut self, time_ms: f64) -> i32 {
        self.inner.find_index_at_timestamp(time_ms)
    }

    #[wasm_bindgen(js_name = getCueStartTime)]
    pub fn get_cue_start_time(&self, index: usize) -> f64 {
        self.inner.get_cue_start_time(index)
    }

    #[wasm_bindgen(js_name = getCueEndTime)]
    pub fn get_cue_end_time(&mut self, index: usize) -> f64 {
        self.inner.get_cue_end_time(index)
    }

    #[wasm_bindgen(js_name = getCueDuration)]
    pub fn get_cue_duration(&mut self, index: usize) -> f64 {
        self.inner.get_cue_duration(index)
    }

    #[wasm_bindgen(js_name = getCueFilePosition)]
    pub fn get_cue_file_position(&self, index: usize) -> f64 {
        self.inner.get_cue_file_position(index)
    }

    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<VobSubFrame> {
        self.inner
            .render_at_index(index)
            .map(|inner| VobSubFrame { inner })
    }

    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        self.inner.clear_cache();
    }

    #[wasm_bindgen(js_name = setDebandEnabled)]
    pub fn set_deband_enabled(&mut self, enabled: bool) {
        self.inner.set_deband_enabled(enabled);
    }

    #[wasm_bindgen(js_name = setDebandThreshold)]
    pub fn set_deband_threshold(&mut self, threshold: f32) {
        self.inner.set_deband_threshold(threshold);
    }

    #[wasm_bindgen(js_name = setDebandRange)]
    pub fn set_deband_range(&mut self, range: u32) {
        self.inner.set_deband_range(range);
    }

    #[wasm_bindgen(getter, js_name = debandEnabled)]
    pub fn deband_enabled(&self) -> bool {
        self.inner.deband_enabled()
    }
}

impl Default for VobSubParser {
    fn default() -> Self {
        Self::new()
    }
}

/// A VobSub subtitle frame.
#[wasm_bindgen]
pub struct VobSubFrame {
    inner: core::VobSubFrame,
}

#[wasm_bindgen]
impl VobSubFrame {
    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.inner.screen_width
    }

    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.inner.screen_height
    }

    #[wasm_bindgen(getter)]
    pub fn x(&self) -> u16 {
        self.inner.x
    }

    #[wasm_bindgen(getter)]
    pub fn y(&self) -> u16 {
        self.inner.y
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u16 {
        self.inner.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u16 {
        self.inner.height
    }

    #[wasm_bindgen(js_name = getRgba)]
    pub fn get_rgba(&self) -> Uint8Array {
        Uint8Array::from(self.inner.get_rgba())
    }
}

/// Subtitle format type.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleFormat {
    Pgs = 0,
    VobSub = 1,
}

/// Unified subtitle renderer for both PGS and VobSub formats.
#[wasm_bindgen]
pub struct SubtitleRenderer {
    pgs_parser: Option<core::PgsParser>,
    vobsub_parser: Option<core::VobSubParser>,
    format: Option<SubtitleFormat>,
}

#[wasm_bindgen]
impl SubtitleRenderer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            pgs_parser: None,
            vobsub_parser: None,
            format: None,
        }
    }

    #[wasm_bindgen(js_name = loadPgs)]
    pub fn load_pgs(&mut self, data: &[u8]) -> usize {
        self.dispose();
        let mut parser = core::PgsParser::new();
        let count = parser.parse(data);
        self.pgs_parser = Some(parser);
        self.format = Some(SubtitleFormat::Pgs);
        count
    }

    #[wasm_bindgen(js_name = loadVobSub)]
    pub fn load_vobsub(&mut self, idx_content: &str, sub_data: Vec<u8>) {
        self.dispose();
        let mut parser = core::VobSubParser::new();
        parser.load_from_data(idx_content, sub_data);
        self.vobsub_parser = Some(parser);
        self.format = Some(SubtitleFormat::VobSub);
    }

    #[wasm_bindgen(js_name = loadVobSubMks)]
    pub fn load_vobsub_mks(&mut self, mks_data: &[u8]) -> Result<(), JsValue> {
        self.dispose();
        let mut parser = core::VobSubParser::new();
        parser
            .load_from_mks(mks_data)
            .map_err(|error| JsValue::from_str(&error))?;
        self.vobsub_parser = Some(parser);
        self.format = Some(SubtitleFormat::VobSub);
        Ok(())
    }

    #[wasm_bindgen(js_name = loadVobSubOnly)]
    pub fn load_vobsub_only(&mut self, sub_data: Vec<u8>) {
        self.dispose();
        let mut parser = core::VobSubParser::new();
        parser.load_from_sub_only(sub_data);
        self.vobsub_parser = Some(parser);
        self.format = Some(SubtitleFormat::VobSub);
    }

    #[wasm_bindgen(getter)]
    pub fn format(&self) -> Option<SubtitleFormat> {
        self.format
    }

    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        match self.format {
            Some(SubtitleFormat::Pgs) => self.pgs_parser.as_ref().map_or(0, |p| p.count()),
            Some(SubtitleFormat::VobSub) => self.vobsub_parser.as_ref().map_or(0, |p| p.count()),
            None => 0,
        }
    }

    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        match self.format {
            Some(SubtitleFormat::Pgs) => self.pgs_parser.as_ref().map_or(0, |p| p.screen_width()),
            Some(SubtitleFormat::VobSub) => {
                self.vobsub_parser.as_ref().map_or(0, |p| p.screen_width())
            }
            None => 0,
        }
    }

    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        match self.format {
            Some(SubtitleFormat::Pgs) => self.pgs_parser.as_ref().map_or(0, |p| p.screen_height()),
            Some(SubtitleFormat::VobSub) => {
                self.vobsub_parser.as_ref().map_or(0, |p| p.screen_height())
            }
            None => 0,
        }
    }

    #[wasm_bindgen(js_name = getCueStartTime)]
    pub fn get_cue_start_time(&mut self, index: usize) -> f64 {
        match self.format {
            Some(SubtitleFormat::Pgs) => self
                .pgs_parser
                .as_ref()
                .map_or(-1.0, |p| p.get_cue_start_time(index)),
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_ref()
                .map_or(-1.0, |p| p.get_cue_start_time(index)),
            None => -1.0,
        }
    }

    #[wasm_bindgen(js_name = getCueEndTime)]
    pub fn get_cue_end_time(&mut self, index: usize) -> f64 {
        match self.format {
            Some(SubtitleFormat::Pgs) => self
                .pgs_parser
                .as_ref()
                .map_or(-1.0, |p| p.get_cue_end_time(index)),
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_mut()
                .map_or(-1.0, |p| p.get_cue_end_time(index)),
            None => -1.0,
        }
    }

    #[wasm_bindgen(js_name = getCueDuration)]
    pub fn get_cue_duration(&mut self, index: usize) -> f64 {
        let start_time = self.get_cue_start_time(index);
        let end_time = self.get_cue_end_time(index);
        if start_time < 0.0 || end_time < 0.0 {
            return -1.0;
        }
        (end_time - start_time).max(0.0)
    }

    #[wasm_bindgen(getter)]
    pub fn language(&self) -> String {
        match self.format {
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_ref()
                .map_or_else(String::new, |p| p.language()),
            _ => String::new(),
        }
    }

    #[wasm_bindgen(getter, js_name = trackId)]
    pub fn track_id(&self) -> String {
        match self.format {
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_ref()
                .map_or_else(String::new, |p| p.track_id()),
            _ => String::new(),
        }
    }

    #[wasm_bindgen(getter, js_name = hasIdxMetadata)]
    pub fn has_idx_metadata(&self) -> bool {
        match self.format {
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_ref()
                .is_some_and(|p| p.has_idx_metadata()),
            _ => false,
        }
    }

    #[wasm_bindgen(getter, js_name = lastRenderIssue)]
    pub fn last_render_issue(&self) -> String {
        match self.format {
            Some(SubtitleFormat::Pgs) => self
                .pgs_parser
                .as_ref()
                .map_or_else(String::new, |p| p.last_render_issue()),
            Some(SubtitleFormat::VobSub) => self
                .vobsub_parser
                .as_ref()
                .map_or_else(String::new, |p| p.last_render_issue()),
            None => String::new(),
        }
    }

    #[wasm_bindgen(js_name = getTimestamps)]
    pub fn get_timestamps(&self) -> Float64Array {
        match self.format {
            Some(SubtitleFormat::Pgs) => self.pgs_parser.as_ref().map_or_else(
                || Float64Array::new_with_length(0),
                |p| timestamps_to_array(p.get_timestamps()),
            ),
            Some(SubtitleFormat::VobSub) => self.vobsub_parser.as_ref().map_or_else(
                || Float64Array::new_with_length(0),
                |p| timestamps_to_array(p.get_timestamps()),
            ),
            None => Float64Array::new_with_length(0),
        }
    }

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

    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<RenderResult> {
        match self.format {
            Some(SubtitleFormat::Pgs) => {
                let frame = self.pgs_parser.as_mut()?.render_at_index(index)?;
                let compositions = frame
                    .compositions
                    .into_iter()
                    .map(|comp| RenderComposition {
                        x: comp.x,
                        y: comp.y,
                        width: comp.width,
                        height: comp.height,
                        rgba: comp.rgba,
                    })
                    .collect();

                Some(RenderResult {
                    screen_width: frame.width,
                    screen_height: frame.height,
                    compositions,
                })
            }
            Some(SubtitleFormat::VobSub) => {
                let frame = self.vobsub_parser.as_mut()?.render_at_index(index)?;
                Some(RenderResult {
                    screen_width: frame.screen_width,
                    screen_height: frame.screen_height,
                    compositions: vec![RenderComposition {
                        x: frame.x,
                        y: frame.y,
                        width: frame.width,
                        height: frame.height,
                        rgba: frame.rgba,
                    }],
                })
            }
            None => None,
        }
    }

    #[wasm_bindgen(js_name = renderAtTimestamp)]
    pub fn render_at_timestamp(&mut self, time_seconds: f64) -> Option<RenderResult> {
        let index = self.find_index_at_timestamp(time_seconds * 1000.0);
        if index < 0 {
            return None;
        }
        self.render_at_index(index as usize)
    }

    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        if let Some(parser) = self.pgs_parser.as_mut() {
            parser.clear_cache();
        }
        if let Some(parser) = self.vobsub_parser.as_mut() {
            parser.clear_cache();
        }
    }

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

    #[wasm_bindgen(getter, js_name = compositionCount)]
    pub fn composition_count(&self) -> usize {
        self.compositions.len()
    }

    #[wasm_bindgen(js_name = getCompositionX)]
    pub fn get_composition_x(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.x)
    }

    #[wasm_bindgen(js_name = getCompositionY)]
    pub fn get_composition_y(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.y)
    }

    #[wasm_bindgen(js_name = getCompositionWidth)]
    pub fn get_composition_width(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.width)
    }

    #[wasm_bindgen(js_name = getCompositionHeight)]
    pub fn get_composition_height(&self, index: usize) -> u16 {
        self.compositions.get(index).map_or(0, |c| c.height)
    }

    #[wasm_bindgen(js_name = getCompositionRgba)]
    pub fn get_composition_rgba(&self, index: usize) -> Uint8Array {
        self.compositions.get(index).map_or_else(
            || Uint8Array::new_with_length(0),
            |c| Uint8Array::from(&c.rgba[..]),
        )
    }
}
