//! PGS file parser and subtitle data management.

use js_sys::{Float64Array, Uint8Array};
use memchr::memchr;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

use super::{
    AssembledObject, DisplaySet, ObjectDefinitionSegment, PaletteDefinitionSegment,
    WindowDefinition, apply_palette, decode_rle_to_indexed,
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
    /// Reusable buffer for RGBA output during rendering
    rgba_buffer: Vec<u32>,
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
            rgba_buffer: Vec::new(),
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
        self.rgba_buffer.clear();

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
        binary_search_timestamp(&self.timestamps_ms, time_ms as u32) as i32
    }

    /// Render subtitle at the given index and return RGBA data.
    /// Returns null if index is invalid or no subtitle data.
    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<SubtitleFrame> {
        if index >= self.display_sets.len() {
            return None;
        }

        // Find boundary (epoch start or acquisition point) for context building
        let boundary_index = self.find_boundary_index(index);

        // Clear cache if we moved to a different epoch/boundary
        if self.last_boundary_index != Some(boundary_index) {
            self.indexed_cache.clear();
            self.last_boundary_index = Some(boundary_index);
        }

        // Get current display set
        let ds = &self.display_sets[index];
        let composition = ds.composition.as_ref()?;

        // Empty composition_objects means clear the screen
        if composition.composition_objects.is_empty() {
            return None;
        }

        let width = composition.width;
        let height = composition.height;

        // Build context from boundary to current index
        let context = self.build_context(boundary_index, index);

        // Find the palette to use
        let palette = context.palettes.get(&composition.palette_id)?;

        // Render all composition objects
        let mut compositions = Vec::new();

        for comp_obj in &composition.composition_objects {
            // Get assembled object
            let obj = match context.objects.get(&comp_obj.object_id) {
                Some(o) => o,
                None => continue, // Skip if object not found (incomplete data)
            };

            // Window lookup is optional - don't fail if not found
            let _window = context.windows.get(&comp_obj.window_id);

            // Decode or get cached indexed pixels
            let cache_key = (obj.id, obj.version);
            let decoded = if let Some(cached) = self.indexed_cache.get(&cache_key) {
                cached
            } else {
                // Decode RLE to indexed pixels
                let pixel_count = (obj.width as usize) * (obj.height as usize);
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

            // Apply palette to get RGBA
            let pixel_count = (decoded.width as usize) * (decoded.height as usize);

            // Ensure buffer has enough capacity and set length
            if self.rgba_buffer.len() < pixel_count {
                self.rgba_buffer.resize(pixel_count, 0);
            }
            apply_palette(
                &decoded.indexed,
                &palette.rgba,
                &mut self.rgba_buffer[..pixel_count],
            );

            // Convert to bytes for JavaScript
            let rgba_bytes: Vec<u8> = self.rgba_buffer[..pixel_count]
                .iter()
                .flat_map(|&c| c.to_le_bytes())
                .collect();

            // comp_obj.x and comp_obj.y are absolute screen positions per PGS spec
            compositions.push(SubtitleComposition {
                x: comp_obj.x,
                y: comp_obj.y,
                width: decoded.width,
                height: decoded.height,
                rgba: rgba_bytes,
            });
        }

        Some(SubtitleFrame {
            width,
            height,
            compositions,
        })
    }

    /// Clear the internal cache.
    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        self.indexed_cache.clear();
        self.last_boundary_index = None;
    }

    /// Find the boundary index (epoch start or acquisition point) before the given index.
    fn find_boundary_index(&self, index: usize) -> usize {
        for i in (0..=index).rev() {
            if let Some(comp) = &self.display_sets[i].composition
                && (comp.is_epoch_start() || comp.is_acquisition_point()) {
                    return i;
                }
        }
        0
    }

    /// Build rendering context from boundary to target index.
    fn build_context(&self, boundary_index: usize, target_index: usize) -> RenderContext {
        let mut context = RenderContext::new();

        for i in boundary_index..=target_index {
            let ds = &self.display_sets[i];

            // Process objects - need to handle multi-segment objects correctly
            for obj in &ds.objects {
                if obj.is_first_in_sequence() {
                    // New object definition - clear any existing parts for this ID
                    context.object_parts.insert(obj.id, vec![obj.clone()]);
                } else {
                    // Continuation segment - append to existing
                    if let Some(parts) = context.object_parts.get_mut(&obj.id) {
                        parts.push(obj.clone());
                    }
                    // If no first segment exists, ignore this continuation
                }
            }

            // Latest palette wins (by ID and version)
            for palette in &ds.palettes {
                context.palettes.insert(palette.id, palette.clone());
            }

            // Latest window wins
            for wds in &ds.windows {
                for window in &wds.windows {
                    context.windows.insert(window.id, *window);
                }
            }
        }

        // Assemble multi-part objects
        for (id, parts) in &context.object_parts {
            if let Some(assembled) = AssembledObject::from_segments(parts) {
                context.objects.insert(*id, assembled);
            }
        }

        context
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
}

/// A single subtitle composition element.
#[wasm_bindgen]
pub struct SubtitleComposition {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    rgba: Vec<u8>,
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
    width: u16,
    height: u16,
    compositions: Vec<SubtitleComposition>,
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
        self.compositions.get(index).map(|c| SubtitleComposition {
            x: c.x,
            y: c.y,
            width: c.width,
            height: c.height,
            rgba: c.rgba.clone(),
        })
    }
}
