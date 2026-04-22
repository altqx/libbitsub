//! PGS file parser and subtitle data management.

use js_sys::{Float64Array, Uint8Array};
use memchr::memchr;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

use super::{
    AssembledObject, DisplaySet, MAX_PGS_BITMAP_PIXELS, ObjectDefinitionSegment,
    PaletteDefinitionSegment, WindowDefinition, apply_palette_rgba_bytes, decode_rle_to_indexed,
};
use crate::utils::binary_search_timestamp;

/// PGS subtitle parser and renderer exposed to JavaScript.
#[wasm_bindgen]
pub struct PgsParser {
    /// All parsed display sets
    display_sets: Vec<DisplaySet>,
    /// Timestamps in milliseconds for quick lookup
    timestamps_ms: Vec<u32>,
    /// Cache for decoded indexed pixels (before palette application)
    indexed_cache: HashMap<(u16, u8), DecodedBitmap>,
    /// Last rendered boundary index (for cache invalidation)
    last_boundary_index: Option<usize>,
    /// Incrementally maintained rendering context for the active epoch.
    cached_context: Option<RenderContext>,
    /// Highest display-set index applied to the cached context.
    cached_context_index: Option<usize>,
    /// Last non-fatal render issue for diagnostics.
    last_render_issue: Option<String>,
}

/// Cached decoded bitmap (indexed pixels, before palette)
struct DecodedBitmap {
    pub indexed: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

#[wasm_bindgen]
impl PgsParser {
    /// Create a new PGS parser.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            display_sets: Vec::new(),
            timestamps_ms: Vec::new(),
            indexed_cache: HashMap::new(),
            last_boundary_index: None,
            cached_context: None,
            cached_context_index: None,
            last_render_issue: None,
        }
    }

    /// Parse a PGS file from binary data.
    /// Returns the number of display sets parsed.
    #[wasm_bindgen]
    pub fn parse(&mut self, data: &[u8]) -> usize {
        self.display_sets.clear();
        self.timestamps_ms.clear();
        self.indexed_cache.clear();
        self.last_boundary_index = None;
        self.cached_context = None;
        self.cached_context_index = None;
        self.last_render_issue = None;

        let len = data.len();

        // Pre-allocate based on typical PGS file structure
        // Roughly 1 display set per 2-5KB, use conservative estimate
        let estimated_count = (len / 3000).max(16);
        self.display_sets.reserve(estimated_count);
        self.timestamps_ms.reserve(estimated_count);

        let mut offset = 0;

        while offset < len {
            if let Some((display_set, consumed)) = DisplaySet::parse(&data[offset..], true) {
                self.timestamps_ms.push(display_set.pts_ms());
                self.display_sets.push(display_set);
                offset += consumed;
            } else {
                // Try to recover by scanning for next magic number using SIMD-accelerated search
                // "PG" (0x50 0x47)
                offset += 1;
                if let Some(pos) = memchr(0x50, &data[offset..]) {
                    let candidate = offset + pos;
                    if candidate + 1 < len && data[candidate + 1] == 0x47 {
                        offset = candidate;
                    } else {
                        // Found 0x50 but not followed by 0x47, continue searching
                        offset = candidate + 1;
                    }
                } else {
                    // No more 0x50 bytes found, done
                    break;
                }
            }
        }

        self.display_sets.len()
    }

    /// Get the number of display sets.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.display_sets.len()
    }

    /// Get the presentation width for this subtitle track.
    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.display_sets
            .iter()
            .find_map(|ds| ds.composition.as_ref().map(|composition| composition.width))
            .unwrap_or(0)
    }

    /// Get the presentation height for this subtitle track.
    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.display_sets
            .iter()
            .find_map(|ds| {
                ds.composition
                    .as_ref()
                    .map(|composition| composition.height)
            })
            .unwrap_or(0)
    }

    /// Get all timestamps in milliseconds as a Float64Array.
    #[wasm_bindgen(js_name = getTimestamps)]
    pub fn get_timestamps(&self) -> Float64Array {
        let arr = Float64Array::new_with_length(self.timestamps_ms.len() as u32);
        for (i, &ts) in self.timestamps_ms.iter().enumerate() {
            arr.set_index(i as u32, ts as f64);
        }
        arr
    }

    /// Find the display set index for a given timestamp in milliseconds.
    #[wasm_bindgen(js_name = findIndexAtTimestamp)]
    pub fn find_index_at_timestamp(&self, time_ms: f64) -> i32 {
        if self.timestamps_ms.is_empty() {
            return -1;
        }

        let time_ms_u32 = time_ms as u32;
        let index = binary_search_timestamp(&self.timestamps_ms, time_ms_u32);
        let start_time = self.timestamps_ms[index];

        if time_ms_u32 < start_time {
            return -1;
        }

        index as i32
    }

    /// Get the cue start time in milliseconds.
    #[wasm_bindgen(js_name = getCueStartTime)]
    pub fn get_cue_start_time(&self, index: usize) -> f64 {
        self.timestamps_ms
            .get(index)
            .copied()
            .map_or(-1.0, |ts| ts as f64)
    }

    /// Get the cue end time in milliseconds.
    #[wasm_bindgen(js_name = getCueEndTime)]
    pub fn get_cue_end_time(&self, index: usize) -> f64 {
        let Some(&start_time) = self.timestamps_ms.get(index) else {
            return -1.0;
        };

        let end_time = self
            .timestamps_ms
            .get(index + 1)
            .copied()
            .unwrap_or_else(|| start_time.saturating_add(5000));

        end_time as f64
    }

    /// Get the number of composition objects in a cue.
    #[wasm_bindgen(js_name = getCueCompositionCount)]
    pub fn get_cue_composition_count(&self, index: usize) -> u32 {
        self.display_sets
            .get(index)
            .and_then(|ds| ds.composition.as_ref())
            .map_or(0, |composition| {
                composition.composition_objects.len() as u32
            })
    }

    /// Get the cue palette ID.
    #[wasm_bindgen(js_name = getCuePaletteId)]
    pub fn get_cue_palette_id(&self, index: usize) -> i32 {
        self.display_sets
            .get(index)
            .and_then(|ds| ds.composition.as_ref())
            .map_or(-1, |composition| composition.palette_id as i32)
    }

    /// Get the cue composition state.
    #[wasm_bindgen(js_name = getCueCompositionState)]
    pub fn get_cue_composition_state(&self, index: usize) -> i32 {
        self.display_sets
            .get(index)
            .and_then(|ds| ds.composition.as_ref())
            .map_or(-1, |composition| composition.composition_state as i32)
    }

    /// Render subtitle at the given index and return RGBA data.
    /// Returns null if index is invalid or no subtitle data.
    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<SubtitleFrame> {
        self.last_render_issue = None;

        if index >= self.display_sets.len() {
            self.last_render_issue = Some("INDEX_OUT_OF_RANGE".to_string());
            return None;
        }

        // Find boundary (epoch start or acquisition point) for context building
        let boundary_index = self.find_boundary_index(index);
        self.ensure_context_for_index(boundary_index, index);

        // Get current display set
        let ds = &self.display_sets[index];
        let Some(composition) = ds.composition.as_ref() else {
            self.last_render_issue = Some("MISSING_COMPOSITION".to_string());
            return None;
        };

        // Empty composition_objects means clear the screen
        if composition.composition_objects.is_empty() {
            self.last_render_issue = Some("EMPTY_CUE".to_string());
            return None;
        }

        let width = composition.width;
        let height = composition.height;

        let Some(context) = self.cached_context.as_ref() else {
            self.last_render_issue = Some("RENDER_CONTEXT_UNAVAILABLE".to_string());
            return None;
        };

        // Find the palette to use
        let Some(palette) = context.palettes.get(&composition.palette_id) else {
            self.last_render_issue = Some("MISSING_PALETTE".to_string());
            return None;
        };

        // Render all composition objects
        let mut compositions = Vec::new();

        for comp_obj in &composition.composition_objects {
            // Get assembled object
            let obj = match context.objects.get(&comp_obj.object_id) {
                Some(obj) => obj,
                None => continue,
            };

            // Window lookup is optional - don't fail if not found
            let _window = context.windows.get(&comp_obj.window_id);

            // Decode or get cached indexed pixels
            let cache_key = (obj.id, obj.version);
            let decoded = if let Some(cached) = self.indexed_cache.get(&cache_key) {
                cached
            } else {
                let pixel_count = match Self::bitmap_pixel_count(obj.width, obj.height) {
                    Some(pixel_count) => pixel_count,
                    None => continue,
                };

                let mut indexed = vec![0u8; pixel_count];
                decode_rle_to_indexed(&obj.data, &mut indexed);

                self.indexed_cache.insert(
                    cache_key,
                    DecodedBitmap {
                        indexed,
                        width: obj.width,
                        height: obj.height,
                    },
                );
                self.indexed_cache.get(&cache_key).unwrap()
            };

            let pixel_count = match Self::bitmap_pixel_count(decoded.width, decoded.height) {
                Some(pixel_count) => pixel_count,
                None => continue,
            };

            let rgba_len = match pixel_count.checked_mul(4) {
                Some(rgba_len) => rgba_len,
                None => continue,
            };

            let mut rgba = vec![0u8; rgba_len];
            apply_palette_rgba_bytes(&decoded.indexed, &palette.rgba, &mut rgba);

            compositions.push(SubtitleComposition {
                x: comp_obj.x,
                y: comp_obj.y,
                width: decoded.width,
                height: decoded.height,
                rgba,
            });
        }

        if compositions.is_empty() {
            self.last_render_issue = Some("EMPTY_RENDER".to_string());
        }

        Some(SubtitleFrame {
            width,
            height,
            compositions,
        })
    }

    /// Get the last non-fatal render issue for diagnostics.
    #[wasm_bindgen(getter, js_name = lastRenderIssue)]
    pub fn last_render_issue(&self) -> String {
        self.last_render_issue.clone().unwrap_or_default()
    }

    /// Clear the internal cache.
    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        self.indexed_cache.clear();
        self.last_boundary_index = None;
        self.cached_context = None;
        self.cached_context_index = None;
        self.last_render_issue = None;
    }

    fn ensure_context_for_index(&mut self, boundary_index: usize, target_index: usize) {
        let needs_rebuild = self.last_boundary_index != Some(boundary_index)
            || self.cached_context.is_none()
            || self
                .cached_context_index
                .is_none_or(|cached_index| target_index < cached_index);

        if needs_rebuild {
            self.indexed_cache.clear();
            self.last_boundary_index = Some(boundary_index);

            let mut context = RenderContext::new();
            self.apply_display_sets(&mut context, boundary_index, target_index);
            self.cached_context = Some(context);
            self.cached_context_index = Some(target_index);
            return;
        }

        let Some(cached_index) = self.cached_context_index else {
            return;
        };

        if cached_index >= target_index {
            return;
        }

        let mut context = self
            .cached_context
            .take()
            .unwrap_or_else(RenderContext::new);
        self.apply_display_sets(&mut context, cached_index + 1, target_index);
        self.cached_context = Some(context);
        self.cached_context_index = Some(target_index);
    }

    /// Find the boundary index (epoch start or acquisition point) before the given index.
    fn find_boundary_index(&self, index: usize) -> usize {
        for i in (0..=index).rev() {
            if let Some(comp) = &self.display_sets[i].composition
                && (comp.is_epoch_start() || comp.is_acquisition_point())
            {
                return i;
            }
        }
        0
    }

    fn apply_display_sets(
        &self,
        context: &mut RenderContext,
        start_index: usize,
        end_index: usize,
    ) {
        for i in start_index..=end_index {
            context.apply_display_set(&self.display_sets[i]);
        }
    }

    fn bitmap_pixel_count(width: u16, height: u16) -> Option<usize> {
        let width = width as usize;
        let height = height as usize;

        if width == 0 || height == 0 {
            return None;
        }

        let pixel_count = width.checked_mul(height)?;
        if pixel_count > MAX_PGS_BITMAP_PIXELS {
            return None;
        }

        Some(pixel_count)
    }
}

impl Default for PgsParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Rendering context built from display sets.
struct RenderContext {
    /// Object parts by ID (before assembly)
    object_parts: HashMap<u16, Vec<ObjectDefinitionSegment>>,
    /// Assembled objects by ID
    objects: HashMap<u16, AssembledObject>,
    /// Palettes by ID
    palettes: HashMap<u8, PaletteDefinitionSegment>,
    /// Windows by ID
    windows: HashMap<u8, WindowDefinition>,
}

impl RenderContext {
    fn new() -> Self {
        Self {
            object_parts: HashMap::new(),
            objects: HashMap::new(),
            palettes: HashMap::new(),
            windows: HashMap::new(),
        }
    }

    fn apply_display_set(&mut self, ds: &DisplaySet) {
        let mut updated_object_ids = Vec::new();

        for obj in &ds.objects {
            if obj.is_first_in_sequence() {
                self.object_parts.insert(obj.id, vec![obj.clone()]);
                updated_object_ids.push(obj.id);
            } else if let Some(parts) = self.object_parts.get_mut(&obj.id) {
                parts.push(obj.clone());
                if !updated_object_ids.contains(&obj.id) {
                    updated_object_ids.push(obj.id);
                }
            }
        }

        for object_id in updated_object_ids {
            if let Some(parts) = self.object_parts.get(&object_id) {
                if let Some(assembled) = AssembledObject::from_segments(parts) {
                    self.objects.insert(object_id, assembled);
                } else {
                    self.objects.remove(&object_id);
                }
            }
        }

        for palette in &ds.palettes {
            self.palettes.insert(palette.id, palette.clone());
        }

        for wds in &ds.windows {
            for window in &wds.windows {
                self.windows.insert(window.id, *window);
            }
        }
    }
}

/// A single subtitle composition element.
#[wasm_bindgen]
#[derive(Clone)]
pub struct SubtitleComposition {
    pub(crate) x: u16,
    pub(crate) y: u16,
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) rgba: Vec<u8>,
}

#[wasm_bindgen]
impl SubtitleComposition {
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> u16 {
        self.x
    }

    #[wasm_bindgen(getter)]
    pub fn y(&self) -> u16 {
        self.y
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u16 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u16 {
        self.height
    }

    /// Get RGBA pixel data as Uint8Array.
    #[wasm_bindgen(js_name = getRgba)]
    pub fn get_rgba(&self) -> Uint8Array {
        Uint8Array::from(&self.rgba[..])
    }
}

/// A complete subtitle frame with all compositions.
#[wasm_bindgen]
pub struct SubtitleFrame {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) compositions: Vec<SubtitleComposition>,
}

#[wasm_bindgen]
impl SubtitleFrame {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u16 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u16 {
        self.height
    }

    /// Get the number of compositions.
    #[wasm_bindgen(getter, js_name = compositionCount)]
    pub fn composition_count(&self) -> usize {
        self.compositions.len()
    }

    /// Get a composition by index.
    #[wasm_bindgen(js_name = getComposition)]
    pub fn get_composition(&self, index: usize) -> Option<SubtitleComposition> {
        self.compositions.get(index).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pgs::{CompositionObject, PresentationCompositionSegment};

    #[test]
    fn find_index_at_timestamp_returns_none_before_first_pts() {
        let mut parser = PgsParser::new();
        parser.timestamps_ms = vec![1200, 2400, 3600];

        assert_eq!(parser.find_index_at_timestamp(0.0), -1);
        assert_eq!(parser.find_index_at_timestamp(1199.0), -1);
        assert_eq!(parser.find_index_at_timestamp(1200.0), 0);
        assert_eq!(parser.find_index_at_timestamp(2500.0), 1);
    }

    #[test]
    fn test_render_at_index_skips_oversized_objects() {
        let mut parser = PgsParser {
            display_sets: vec![DisplaySet {
                pts: 0,
                dts: 0,
                composition: Some(PresentationCompositionSegment {
                    width: 1920,
                    height: 1080,
                    frame_rate: 0,
                    composition_number: 0,
                    composition_state: 0,
                    palette_update_flag: 0,
                    palette_id: 0,
                    composition_objects: vec![CompositionObject {
                        object_id: 1,
                        window_id: 0,
                        cropped_flag: 0,
                        x: 0,
                        y: 0,
                        crop_x: 0,
                        crop_y: 0,
                        crop_width: 0,
                        crop_height: 0,
                    }],
                }),
                palettes: vec![PaletteDefinitionSegment {
                    id: 0,
                    version: 0,
                    rgba: vec![0u32; 256],
                }],
                objects: vec![ObjectDefinitionSegment {
                    id: 1,
                    version: 0,
                    sequence_flag: 0xC0,
                    data_length: 1,
                    width: 5000,
                    height: 5000,
                    data: vec![1],
                }],
                windows: Vec::new(),
            }],
            timestamps_ms: vec![0],
            indexed_cache: HashMap::new(),
            last_boundary_index: None,
            cached_context: None,
            cached_context_index: None,
            last_render_issue: None,
        };

        let frame = parser.render_at_index(0).expect("frame should exist");

        assert_eq!(frame.composition_count(), 0);
    }
}
