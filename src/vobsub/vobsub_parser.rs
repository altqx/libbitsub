//! VobSub parser exposed to JavaScript via WASM.

use js_sys::{Float64Array, Uint8Array};
use memchr::memchr;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

use super::{
    DebandConfig, IdxParseResult, SubtitlePacket, VobSubPalette, VobSubTimestamp,
    apply_deband, decode_vobsub_rle, parse_idx, parse_subtitle_packet,
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
    /// Debanding configuration
    deband_config: DebandConfig,
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
            deband_config: DebandConfig::default(),
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

        // Pre-allocate with estimate (roughly 1 subtitle per 10KB)
        let estimated_count = (sub_data.len() / 10000).max(32);
        let mut timestamps: Vec<VobSubTimestamp> = Vec::with_capacity(estimated_count);
        let mut offset = 0;
        let len = sub_data.len();

        // Look for MPEG-2 PS pack start code
        while offset < len.saturating_sub(4) {
            // Find next potential start code (0x00 0x00 0x01 0xBA)
            if let Some(pos) = memchr(0x00, &sub_data[offset..]) {
                let candidate = offset + pos;

                // Check for full start code: 00 00 01 BA
                if candidate + 3 < len
                    && sub_data[candidate + 1] == 0x00
                    && sub_data[candidate + 2] == 0x01
                    && sub_data[candidate + 3] == 0xBA
                {
                    if let Some((packet, _)) = parse_subtitle_packet(sub_data, candidate, &palette)
                    {
                        if packet.width > 0 && packet.height > 0 {
                            timestamps.push(VobSubTimestamp {
                                timestamp_ms: packet.timestamp_ms,
                                file_position: candidate as u64,
                            });
                        }
                    }
                }
                offset = candidate + 1;
            } else {
                // No more 0x00 bytes found
                break;
            }
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
    /// Returns -1 if no subtitle should be displayed at this time.
    #[wasm_bindgen(js_name = findIndexAtTimestamp)]
    pub fn find_index_at_timestamp(&mut self, time_ms: f64) -> i32 {
        if self.timestamps_ms.is_empty() {
            return -1;
        }

        let time_ms_u32 = time_ms as u32;
        let index = binary_search_timestamp(&self.timestamps_ms, time_ms_u32);

        // Get the start time from IDX (what we searched against)
        let start_time = self.timestamps_ms[index];

        // Don't show if we're before this subtitle's start time
        if time_ms_u32 < start_time {
            return -1;
        }

        // Calculate end time
        let end_time = self.calculate_end_time(index, start_time);

        if time_ms_u32 < end_time {
            return index as i32;
        }

        // Current time is past the subtitle's duration
        -1
    }
    /// Calculate the end time for a subtitle at the given index.
    fn calculate_end_time(&mut self, index: usize, start_time: u32) -> u32 {
        // Maximum duration for the last subtitle (no next subtitle to clamp to)
        const MAX_LAST_DURATION_MS: u32 = 5000;

        // Try to get explicit duration from control sequence first
        let explicit_duration = self
            .get_or_parse_packet(index)
            .filter(|p| p.duration_ms > 0 && p.duration_ms != 5000)
            .map(|p| p.duration_ms);

        // Check if we have a next subtitle
        if index + 1 < self.timestamps_ms.len() {
            let next_start = self.timestamps_ms[index + 1];

            if let Some(duration) = explicit_duration {
                let explicit_end = start_time.saturating_add(duration);
                return explicit_end.min(next_start);
            }

            next_start
        } else {
            // Last subtitle - use explicit duration if valid, otherwise default
            if let Some(duration) = explicit_duration {
                return start_time.saturating_add(duration);
            }
            // Default duration for last subtitle
            start_time.saturating_add(MAX_LAST_DURATION_MS)
        }
    }

    /// Get a packet from cache or parse it.
    fn get_or_parse_packet(&mut self, index: usize) -> Option<SubtitlePacket> {
        let idx_data = self.idx_data.as_ref()?;
        let sub_data = self.sub_data.as_ref()?;

        if index >= idx_data.timestamps.len() {
            return None;
        }

        // Check cache first
        if let Some(cached) = self.packet_cache.get(&index) {
            return cached.clone();
        }

        // Parse packet at file position
        let timestamp = &idx_data.timestamps[index];
        let packet = parse_subtitle_packet(
            sub_data,
            timestamp.file_position as usize,
            &idx_data.palette,
        )
        .map(|(p, _)| p);

        // Cache result
        self.packet_cache.insert(index, packet.clone());

        packet
    }

    /// Render subtitle at the given index and return RGBA data.
    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<VobSubFrame> {
        let packet = self.get_or_parse_packet(index)?;
        let idx_data = self.idx_data.as_ref()?;

        Some(self.render_packet(&packet, &idx_data.palette, &idx_data.metadata))
    }

    /// Render a packet to a frame.
    fn render_packet(
        &self,
        packet: &SubtitlePacket,
        palette: &VobSubPalette,
        metadata: &super::VobSubMetadata,
    ) -> VobSubFrame {
        let mut rgba = decode_vobsub_rle(packet, palette);

        // Apply debanding if enabled
        if self.deband_config.enabled {
            rgba = apply_deband(
                &rgba,
                packet.width as usize,
                packet.height as usize,
                &self.deband_config,
            );
        }

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

    /// Enable or disable debanding.
    #[wasm_bindgen(js_name = setDebandEnabled)]
    pub fn set_deband_enabled(&mut self, enabled: bool) {
        self.deband_config.enabled = enabled;
    }

    /// Set the deband threshold (0.0-255.0, default: 64.0).
    #[wasm_bindgen(js_name = setDebandThreshold)]
    pub fn set_deband_threshold(&mut self, threshold: f32) {
        self.deband_config.threshold = threshold.clamp(0.0, 255.0);
    }

    /// Set the deband sample range in pixels (default: 15).
    #[wasm_bindgen(js_name = setDebandRange)]
    pub fn set_deband_range(&mut self, range: u32) {
        self.deband_config.range = range.clamp(1, 64);
    }

    /// Check if debanding is enabled.
    #[wasm_bindgen(getter, js_name = debandEnabled)]
    pub fn deband_enabled(&self) -> bool {
        self.deband_config.enabled
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
