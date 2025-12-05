//! PGS file parser and subtitle data management.

use wasm_bindgen::prelude::*;
use js_sys::{Uint8Array, Float64Array};
use std::collections::HashMap;

use super::{
    DisplaySet,
    PaletteDefinitionSegment,
    ObjectDefinitionSegment,
    AssembledObject,
    WindowDefinition,
    apply_palette,
    decode_rle_to_indexed,
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
        }
    }

    /// Parse a PGS file from binary data.
    /// Returns the number of display sets parsed.
    #[wasm_bindgen]
    pub fn parse(&mut self, data: &[u8]) -> usize {
        self.display_sets.clear();
        self.timestamps_ms.clear();
        self.indexed_cache.clear();

        let mut offset = 0;
        let len = data.len();

        while offset < len {
            if let Some((display_set, consumed)) = DisplaySet::parse(&data[offset..], true) {
                self.timestamps_ms.push(display_set.pts_ms());
                self.display_sets.push(display_set);
                offset += consumed;
            } else {
                // Try to recover by scanning for next magic number
                offset += 1;
                while offset < len - 1 {
                    if data[offset] == 0x50 && data[offset + 1] == 0x47 {
                        break;
                    }
                    offset += 1;
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
        
        // Build context from boundary to current index
        let context = self.build_context(boundary_index, index);
        
        // Get current display set
        let ds = &self.display_sets[index];
        let composition = ds.composition.as_ref()?;

        if composition.composition_objects.is_empty() {
            return None;
        }

        let width = composition.width;
        let height = composition.height;

        // Find the palette to use
        let palette = context.palettes.get(&composition.palette_id)?;

        // Render all composition objects
        let mut compositions = Vec::new();

        for comp_obj in &composition.composition_objects {
            // Get assembled object
            let obj = context.objects.get(&comp_obj.object_id)?;
            
            // Find window (used for validation, not positioning)
            let _window = context.windows.get(&comp_obj.window_id)?;

            // Decode or get cached indexed pixels
            let cache_key = (obj.id, obj.version);
            let decoded = if let Some(cached) = self.indexed_cache.get(&cache_key) {
                cached
            } else {
                // Decode RLE to indexed pixels
                let pixel_count = (obj.width as usize) * (obj.height as usize);
                let mut indexed = vec![0u8; pixel_count];
                decode_rle_to_indexed(&obj.data, &mut indexed);
                
                self.indexed_cache.insert(cache_key, DecodedBitmap {
                    indexed,
                    width: obj.width,
                    height: obj.height,
                });
                self.indexed_cache.get(&cache_key).unwrap()
            };

            // Apply palette to get RGBA
            let pixel_count = (decoded.width as usize) * (decoded.height as usize);
            let mut rgba = vec![0u32; pixel_count];
            apply_palette(&decoded.indexed, &palette.rgba, &mut rgba);

            // Convert to bytes for JavaScript
            let rgba_bytes: Vec<u8> = rgba.iter()
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
    }

    /// Find the boundary index (epoch start or acquisition point) before the given index.
    fn find_boundary_index(&self, index: usize) -> usize {
        for i in (0..=index).rev() {
            if let Some(comp) = &self.display_sets[i].composition {
                if comp.is_epoch_start() || comp.is_acquisition_point() {
                    return i;
                }
            }
        }
        0
    }

    /// Build rendering context from boundary to target index.
    fn build_context(&self, boundary_index: usize, target_index: usize) -> RenderContext {
        let mut context = RenderContext::new();

        for i in boundary_index..=target_index {
            let ds = &self.display_sets[i];

            // Accumulate objects
            for obj in &ds.objects {
                let objects = context.object_parts
                    .entry(obj.id)
                    .or_insert_with(Vec::new);
                objects.push(obj.clone());
            }

            // Latest palette wins
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
