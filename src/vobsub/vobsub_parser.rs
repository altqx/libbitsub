//! VobSub parser exposed to JavaScript via WASM.

use wasm_bindgen::prelude::*;
use js_sys::{Uint8Array, Float64Array};
use std::collections::HashMap;

use super::{
    parse_idx,
    parse_subtitle_packet,
    decode_vobsub_rle,
    IdxParseResult,
    VobSubPalette,
    VobSubTimestamp,
    SubtitlePacket,
};
use crate::utils::binary_search_timestamp;

/// VobSub subtitle parser and renderer exposed to JavaScript.
#[wasm_bindgen]
pub struct VobSubParser {
    /// Parsed IDX data
    idx_data: Option<IdxParseResult>,
    /// Raw SUB file data
    sub_data: Option<Vec<u8>>,
    /// Timestamps in milliseconds for quick lookup
    timestamps_ms: Vec<u32>,
    /// Cache for decoded subtitle packets
    packet_cache: HashMap<usize, Option<SubtitlePacket>>,
}

#[wasm_bindgen]
impl VobSubParser {
    /// Create a new VobSub parser.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            idx_data: None,
            sub_data: None,
            timestamps_ms: Vec::new(),
            packet_cache: HashMap::new(),
        }
    }

    /// Load VobSub from IDX content and SUB data.
    #[wasm_bindgen(js_name = loadFromData)]
    pub fn load_from_data(&mut self, idx_content: &str, sub_data: &[u8]) {
        self.dispose();
        
        // Parse IDX
        let idx = parse_idx(idx_content);
        self.timestamps_ms = idx.timestamps.iter().map(|t| t.timestamp_ms).collect();
        self.idx_data = Some(idx);
        self.sub_data = Some(sub_data.to_vec());
    }

    /// Load VobSub from SUB file only (scans for timestamps).
    #[wasm_bindgen(js_name = loadFromSubOnly)]
    pub fn load_from_sub_only(&mut self, sub_data: &[u8]) {
        self.dispose();
        
        // Default palette
        let palette = VobSubPalette::default();
        
        // Scan for packets
        let mut timestamps: Vec<VobSubTimestamp> = Vec::new();
        let mut offset = 0;
        
        while offset < sub_data.len().saturating_sub(4) {
            // Look for MPEG-2 PS pack start code
            if sub_data[offset] == 0x00 
                && sub_data[offset + 1] == 0x00 
                && sub_data[offset + 2] == 0x01 
                && sub_data[offset + 3] == 0xBA 
            {
                if let Some((packet, _)) = parse_subtitle_packet(sub_data, offset, &palette) {
                    if packet.width > 0 && packet.height > 0 {
                        timestamps.push(VobSubTimestamp {
                            timestamp_ms: packet.timestamp_ms,
                            file_position: offset as u64,
                        });
                    }
                }
            }
            offset += 1;
        }

        // Sort and store
        timestamps.sort_by_key(|t| t.timestamp_ms);
        self.timestamps_ms = timestamps.iter().map(|t| t.timestamp_ms).collect();
        
        self.idx_data = Some(IdxParseResult {
            palette,
            timestamps,
            metadata: Default::default(),
        });
        self.sub_data = Some(sub_data.to_vec());
    }

    /// Dispose of all resources.
    #[wasm_bindgen]
    pub fn dispose(&mut self) {
        self.idx_data = None;
        self.sub_data = None;
        self.timestamps_ms.clear();
        self.packet_cache.clear();
    }

    /// Get the number of subtitle entries.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.timestamps_ms.len()
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

    /// Find the subtitle index for a given timestamp in milliseconds.
    #[wasm_bindgen(js_name = findIndexAtTimestamp)]
    pub fn find_index_at_timestamp(&self, time_ms: f64) -> i32 {
        if self.timestamps_ms.is_empty() {
            return -1;
        }
        binary_search_timestamp(&self.timestamps_ms, time_ms as u32) as i32
    }

    /// Render subtitle at the given index and return RGBA data.
    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<VobSubFrame> {
        let idx_data = self.idx_data.as_ref()?;
        let sub_data = self.sub_data.as_ref()?;
        
        if index >= idx_data.timestamps.len() {
            return None;
        }

        // Check cache
        if let Some(cached) = self.packet_cache.get(&index) {
            return cached.as_ref().map(|packet| {
                self.render_packet(packet, &idx_data.palette, &idx_data.metadata)
            });
        }

        // Parse packet at file position
        let timestamp = &idx_data.timestamps[index];
        let packet = parse_subtitle_packet(sub_data, timestamp.file_position as usize, &idx_data.palette)
            .map(|(p, _)| p);

        // Cache result
        self.packet_cache.insert(index, packet.clone());

        packet.as_ref().map(|p| self.render_packet(p, &idx_data.palette, &idx_data.metadata))
    }

    /// Render a packet to a frame.
    fn render_packet(
        &self,
        packet: &SubtitlePacket,
        palette: &VobSubPalette,
        metadata: &super::VobSubMetadata,
    ) -> VobSubFrame {
        let rgba = decode_vobsub_rle(packet, palette);

        VobSubFrame {
            screen_width: metadata.width,
            screen_height: metadata.height,
            x: packet.x,
            y: packet.y,
            width: packet.width,
            height: packet.height,
            rgba,
        }
    }

    /// Clear the internal cache.
    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        self.packet_cache.clear();
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
    screen_width: u16,
    screen_height: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl VobSubFrame {
    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.screen_width
    }

    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.screen_height
    }

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
