//! VobSub parser exposed to JavaScript via WASM.

use js_sys::{Float64Array, Uint8Array};
use memchr::memchr;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

use super::{
    DebandConfig, ExtractedVobSub, IdxParseResult, SubtitlePacket, VobSubPalette, VobSubTimestamp,
    apply_deband, decode_vobsub_rle, extract_vobsub_from_mks, parse_idx, parse_subtitle_packet,
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
    /// Whether the parser was loaded from IDX metadata.
    loaded_from_idx: bool,
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
            loaded_from_idx: false,
        }
    }

    /// Load VobSub from IDX content and SUB data.
    #[wasm_bindgen(js_name = loadFromData)]
    pub fn load_from_data(&mut self, idx_content: &str, sub_data: Vec<u8>) {
        self.dispose();
        self.apply_loaded_data(parse_idx(idx_content), sub_data, true);
    }

    /// Load VobSub from a Matroska subtitle container with embedded S_VOBSUB tracks.
    #[wasm_bindgen(js_name = loadFromMks)]
    pub fn load_from_mks(&mut self, mks_data: &[u8]) -> Result<(), JsValue> {
        self.dispose();

        let ExtractedVobSub {
            idx_content,
            sub_data,
            language,
            track_id,
        } = extract_vobsub_from_mks(mks_data).map_err(|error| JsValue::from_str(&error))?;

        let mut idx = parse_idx(&idx_content);
        if language.is_some() {
            idx.metadata.language = language;
        }
        if track_id.is_some() {
            idx.metadata.id = track_id;
        }

        self.apply_loaded_data(idx, sub_data, true);
        Ok(())
    }

    /// Load VobSub from SUB file only (scans for timestamps).
    #[wasm_bindgen(js_name = loadFromSubOnly)]
    pub fn load_from_sub_only(&mut self, sub_data: Vec<u8>) {
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
                    && let Some((packet, _)) = parse_subtitle_packet(&sub_data, candidate, &palette)
                    && packet.width > 0
                    && packet.height > 0
                {
                    timestamps.push(VobSubTimestamp {
                        timestamp_ms: packet.timestamp_ms,
                        file_position: candidate as u64,
                    });
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

        let idx = IdxParseResult {
            palette,
            timestamps,
            metadata: Default::default(),
        };
        self.apply_loaded_data(idx, sub_data, false);
    }

    /// Dispose of all resources.
    #[wasm_bindgen]
    pub fn dispose(&mut self) {
        self.idx_data = None;
        self.sub_data = None;
        self.timestamps_ms.clear();
        self.packet_cache.clear();
        self.loaded_from_idx = false;
    }

    /// Get the number of subtitle entries.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> usize {
        self.timestamps_ms.len()
    }

    /// Get the presentation width for this subtitle track.
    #[wasm_bindgen(getter, js_name = screenWidth)]
    pub fn screen_width(&self) -> u16 {
        self.idx_data
            .as_ref()
            .map_or(0, |idx_data| idx_data.metadata.width)
    }

    /// Get the presentation height for this subtitle track.
    #[wasm_bindgen(getter, js_name = screenHeight)]
    pub fn screen_height(&self) -> u16 {
        self.idx_data
            .as_ref()
            .map_or(0, |idx_data| idx_data.metadata.height)
    }

    /// Get the declared language code from IDX metadata.
    #[wasm_bindgen(getter)]
    pub fn language(&self) -> String {
        self.idx_data
            .as_ref()
            .and_then(|idx_data| idx_data.metadata.language.clone())
            .unwrap_or_default()
    }

    /// Get the declared subtitle track ID from IDX metadata.
    #[wasm_bindgen(getter, js_name = trackId)]
    pub fn track_id(&self) -> String {
        self.idx_data
            .as_ref()
            .and_then(|idx_data| idx_data.metadata.id.clone())
            .unwrap_or_default()
    }

    /// Check whether IDX metadata was used to load the parser.
    #[wasm_bindgen(getter, js_name = hasIdxMetadata)]
    pub fn has_idx_metadata(&self) -> bool {
        self.loaded_from_idx
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
    pub fn get_cue_end_time(&mut self, index: usize) -> f64 {
        let Some(&start_time) = self.timestamps_ms.get(index) else {
            return -1.0;
        };

        self.calculate_end_time(index, start_time) as f64
    }

    /// Get the cue duration in milliseconds.
    #[wasm_bindgen(js_name = getCueDuration)]
    pub fn get_cue_duration(&mut self, index: usize) -> f64 {
        let Some(&start_time) = self.timestamps_ms.get(index) else {
            return -1.0;
        };

        self.calculate_end_time(index, start_time)
            .saturating_sub(start_time) as f64
    }

    /// Get the cue file position in the SUB file.
    #[wasm_bindgen(js_name = getCueFilePosition)]
    pub fn get_cue_file_position(&self, index: usize) -> f64 {
        self.idx_data
            .as_ref()
            .and_then(|idx_data| idx_data.timestamps.get(index).copied())
            .map_or(-1.0, |timestamp| timestamp.file_position as f64)
    }

    fn apply_loaded_data(
        &mut self,
        idx_data: IdxParseResult,
        sub_data: Vec<u8>,
        loaded_from_idx: bool,
    ) {
        self.timestamps_ms = idx_data.timestamps.iter().map(|t| t.timestamp_ms).collect();
        self.idx_data = Some(idx_data);
        self.sub_data = Some(sub_data);
        self.loaded_from_idx = loaded_from_idx;
    }

    /// Calculate the end time for a subtitle at the given index.
    fn calculate_end_time(&mut self, index: usize, start_time: u32) -> u32 {
        // Maximum duration for the last subtitle (no next subtitle to clamp to)
        const MAX_LAST_DURATION_MS: u32 = 5000;

        // Try to get explicit duration from control sequence first
        self.ensure_packet_cached(index);
        let explicit_duration = self
            .cached_packet(index)
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

    fn ensure_packet_cached(&mut self, index: usize) -> Option<()> {
        let idx_data = self.idx_data.as_ref()?;
        if index >= idx_data.timestamps.len() {
            return None;
        }

        if self.packet_cache.contains_key(&index) {
            return Some(());
        }

        let packet = {
            let idx_data = self.idx_data.as_ref()?;
            let sub_data = self.sub_data.as_ref()?;
            let timestamp = idx_data.timestamps.get(index)?;

            parse_subtitle_packet(
                sub_data,
                timestamp.file_position as usize,
                &idx_data.palette,
            )
            .map(|(p, _)| p)
        };

        self.packet_cache.insert(index, packet);
        Some(())
    }

    fn cached_packet(&self, index: usize) -> Option<&SubtitlePacket> {
        self.packet_cache.get(&index).and_then(|packet| packet.as_ref())
    }

    /// Render subtitle at the given index and return RGBA data.
    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index(&mut self, index: usize) -> Option<VobSubFrame> {
        self.ensure_packet_cached(index)?;
        let idx_data = self.idx_data.as_ref()?;
        let sub_data = self.sub_data.as_ref()?;
        let packet = self.cached_packet(index)?;

        Some(self.render_packet(packet, sub_data, &idx_data.palette, &idx_data.metadata))
    }

    /// Render a packet to a frame.
    fn render_packet(
        &self,
        packet: &SubtitlePacket,
        sub_data: &[u8],
        palette: &VobSubPalette,
        metadata: &super::VobSubMetadata,
    ) -> VobSubFrame {
        let mut rgba = decode_vobsub_rle(packet, sub_data, palette);

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
    pub(crate) screen_width: u16,
    pub(crate) screen_height: u16,
    pub(crate) x: u16,
    pub(crate) y: u16,
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) rgba: Vec<u8>,
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
