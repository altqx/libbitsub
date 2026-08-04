//! High-level DVB subtitle parser API (PGS-like surface).

use super::context::{DisplayCue, DvbComposition, DvbContext, DvbFrame};
use super::pes::{TimedPayload, parse_timed_stream};
use crate::utils::binary_search_timestamp;

/// DVB subtitle parser and renderer.
pub struct DvbParser {
    cues: Vec<DisplayCue>,
    timestamps_ms: Vec<u32>,
    pending: Vec<u8>,
    context: DvbContext,
    last_render_issue: Option<String>,
    screen_width: u16,
    screen_height: u16,
}

impl DvbParser {
    pub fn new() -> Self {
        Self {
            cues: Vec::new(),
            timestamps_ms: Vec::new(),
            pending: Vec::new(),
            context: DvbContext::new(),
            last_render_issue: None,
            screen_width: super::DEFAULT_SCREEN_WIDTH,
            screen_height: super::DEFAULT_SCREEN_HEIGHT,
        }
    }

    pub fn reset(&mut self) {
        self.cues.clear();
        self.timestamps_ms.clear();
        self.pending.clear();
        self.context.reset();
        self.last_render_issue = None;
        self.screen_width = super::DEFAULT_SCREEN_WIDTH;
        self.screen_height = super::DEFAULT_SCREEN_HEIGHT;
    }

    /// Parse a complete DVB dump (`"DV"` framed and/or MPEG PES).
    pub fn parse(&mut self, data: &[u8]) -> usize {
        self.reset();
        let (units, _) = parse_timed_stream(data);
        self.ingest_units(units);
        self.cues.len()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> usize {
        if chunk.is_empty() && self.pending.is_empty() {
            return 0;
        }

        self.pending.extend_from_slice(chunk);
        let before = self.cues.len();
        let (units, consumed) = parse_timed_stream(&self.pending);
        if consumed > 0 {
            self.pending.drain(..consumed);
            self.ingest_units(units);
        }
        self.cues.len() - before
    }

    pub fn finish_feed(&mut self) -> usize {
        if !self.pending.is_empty() {
            let (units, consumed) = parse_timed_stream(&self.pending);
            if consumed > 0 {
                self.pending.drain(..consumed);
                self.ingest_units(units);
            }
            // Leftover incomplete bytes are dropped.
            self.pending.clear();
        }
        self.cues.len()
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    fn ingest_units(&mut self, units: Vec<TimedPayload>) {
        for unit in units {
            let Some(cue) = self.context.apply_payload(unit.pts_ms, &unit.payload) else {
                continue;
            };
            self.screen_width = cue.screen_width;
            self.screen_height = cue.screen_height;
            self.timestamps_ms.push(cue.pts_ms);
            self.cues.push(cue);
        }
    }

    pub fn count(&self) -> usize {
        self.cues.len()
    }

    pub fn screen_width(&self) -> u16 {
        self.screen_width
    }

    pub fn screen_height(&self) -> u16 {
        self.screen_height
    }

    pub fn get_timestamps(&self) -> Vec<f64> {
        self.timestamps_ms.iter().map(|&ts| ts as f64).collect()
    }

    pub fn get_end_timestamps(&self) -> Vec<f64> {
        (0..self.cues.len())
            .map(|index| self.get_cue_end_time_ms(index) as f64)
            .collect()
    }

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

        let end_time = self.get_cue_end_time_ms(index);
        if time_ms_u32 >= end_time {
            return -1;
        }

        index as i32
    }

    pub fn get_cue_start_time(&self, index: usize) -> f64 {
        self.timestamps_ms
            .get(index)
            .copied()
            .map_or(-1.0, |ts| ts as f64)
    }

    fn get_cue_end_time_ms(&self, index: usize) -> u32 {
        let Some(cue) = self.cues.get(index) else {
            return 0;
        };

        let timeout_end = cue.pts_ms.saturating_add(cue.timeout_ms);
        if let Some(&next) = self.timestamps_ms.get(index + 1) {
            next.min(timeout_end)
        } else {
            timeout_end
        }
    }

    pub fn get_cue_end_time(&self, index: usize) -> f64 {
        if index >= self.cues.len() {
            return -1.0;
        }
        self.get_cue_end_time_ms(index) as f64
    }

    pub fn get_cue_composition_count(&self, index: usize) -> u32 {
        self.cues
            .get(index)
            .and_then(|cue| cue.frame.as_ref())
            .map_or(0, |frame| frame.compositions.len() as u32)
    }

    pub fn get_cue_page_state(&self, index: usize) -> i32 {
        self.cues.get(index).map_or(-1, |cue| cue.page_state as i32)
    }

    pub fn last_render_issue(&self) -> String {
        self.last_render_issue.clone().unwrap_or_default()
    }

    pub fn clear_cache(&mut self) {
        // Frames are snapshotted on ingest; nothing to clear beyond issue text.
        self.last_render_issue = None;
    }

    pub fn render_at_index(&mut self, index: usize) -> Option<DvbFrame> {
        self.last_render_issue = None;

        let Some(cue) = self.cues.get(index) else {
            self.last_render_issue = Some("INDEX_OUT_OF_RANGE".to_string());
            return None;
        };

        cue.frame.clone()
    }

    pub fn render_at_timestamp(&mut self, time_seconds: f64) -> Option<DvbFrame> {
        let index = self.find_index_at_timestamp(time_seconds * 1000.0);
        if index < 0 {
            return None;
        }

        self.render_at_index(index as usize)
    }
}

impl Default for DvbParser {
    fn default() -> Self {
        Self::new()
    }
}

impl DvbFrame {
    pub fn composition_count(&self) -> usize {
        self.compositions.len()
    }

    pub fn get_composition(&self, index: usize) -> Option<DvbComposition> {
        self.compositions.get(index).cloned()
    }
}

impl DvbComposition {
    pub fn get_rgba(&self) -> &[u8] {
        &self.rgba
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dvb::pes::encode_dv_frame;
    use crate::dvb::segment::{
        END_OF_DISPLAY_SET, OBJECT_DATA, PAGE_COMPOSITION, REGION_COMPOSITION, SYNC_BYTE,
    };

    fn segment(segment_type: u8, page_id: u16, data: &[u8]) -> Vec<u8> {
        let mut out = vec![SYNC_BYTE, segment_type];
        out.extend_from_slice(&page_id.to_be_bytes());
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(data);
        out
    }

    fn build_simple_display_set() -> Vec<u8> {
        // Page: timeout 5s, version 0, mode-change, region 1 at (10, 20)
        let mut page = vec![0x05, 0x08]; // state = mode-change (bits 3:2 = 10)
        page.extend_from_slice(&[0x01, 0x00, 0x00, 0x0A, 0x00, 0x14]);

        // Region 1: 4x2, depth 8 (encoded as 3 << 2), clut 0, fill, no objects initially then object
        // depth field: bits 5-3 = region_depth; FFmpeg uses (buf[6] >> 2) & 7
        // EN 300 743: region_depth is 3 bits. Value 0x08 => depth code 2 = 4-bit; 0x0C => 3 = 8-bit
        let region = vec![
            0x01, // region id
            0x08, // version 0, fill=1
            0x00, 0x04, // width 4
            0x00, 0x02, // height 2
            0x0C, // depth code 3 (8-bit)
            0x00, // clut id
            0x00, // 8-bit bgcolor
            0x00, // 4/2 bgcolor packed
            0x00, 0x01, // object id 1
            0x00, // type 0, provider 0, x high
            0x00, // x
            0x00, // y high
            0x00, // y
        ];

        // Object 1: coding method 0, top field with two 8-bit pixels then EOL
        // top field: 0x12 (8-bit string) + pixels 1,2 + 0x00 0x00 end + 0xF0 eol
        let top_field = [0x12, 0x01, 0x02, 0x00, 0x00, 0xF0];
        let mut object = vec![
            0x00, 0x01, // object id
            0x00, // coding method 0, non_mod 0
        ];
        object.extend_from_slice(&(top_field.len() as u16).to_be_bytes());
        object.extend_from_slice(&0u16.to_be_bytes()); // bottom field len 0 => duplicate
        object.extend_from_slice(&top_field);

        let mut payload = vec![0x20, 0x00];
        payload.extend(segment(PAGE_COMPOSITION, 1, &page));
        payload.extend(segment(REGION_COMPOSITION, 1, &region));
        payload.extend(segment(OBJECT_DATA, 1, &object));
        payload.extend(segment(END_OF_DISPLAY_SET, 1, &[]));
        payload.push(0xFF);
        payload
    }

    fn build_page_only(state: u8, with_region: bool) -> Vec<u8> {
        let mut page = vec![0x05, (1 << 4) | (state << 2)];
        if with_region {
            page.extend_from_slice(&[0x01, 0x00, 0x00, 0x0A, 0x00, 0x14]);
        }

        let mut payload = vec![0x20, 0x00];
        payload.extend(segment(PAGE_COMPOSITION, 1, &page));
        payload.extend(segment(END_OF_DISPLAY_SET, 1, &[]));
        payload.push(0xFF);
        payload
    }

    #[test]
    fn parse_and_render_framed_dump() {
        let payload = build_simple_display_set();
        let framed = encode_dv_frame(180_000, &payload); // 2s

        let mut parser = DvbParser::new();
        let count = parser.parse(&framed);
        assert_eq!(count, 1);
        assert_eq!(parser.get_cue_start_time(0), 2000.0);

        let frame = parser.render_at_index(0).expect("frame");
        assert_eq!(frame.width, 720);
        assert_eq!(frame.height, 576);
        assert_eq!(frame.compositions.len(), 1);
        assert_eq!(frame.compositions[0].x, 10);
        assert_eq!(frame.compositions[0].y, 20);
        assert_eq!(frame.compositions[0].width, 4);
        assert_eq!(frame.compositions[0].height, 2);
    }

    #[test]
    fn feed_progressive() {
        let payload = build_simple_display_set();
        let framed = encode_dv_frame(90_000, &payload);
        let mut parser = DvbParser::new();

        let mid = framed.len() / 2;
        assert_eq!(parser.feed(&framed[..mid]), 0);
        assert!(parser.pending_len() > 0);
        assert_eq!(parser.feed(&framed[mid..]), 1);
        assert_eq!(parser.count(), 1);
    }

    #[test]
    fn cue_timeout_creates_a_gap_before_the_next_cue() {
        let payload = build_simple_display_set();
        let framed = encode_dv_frame(180_000, &payload); // starts at 2s, times out at 7s
        let mut parser = DvbParser::new();

        parser.parse(&framed);

        assert_eq!(parser.get_end_timestamps(), vec![7000.0]);
        assert_eq!(parser.find_index_at_timestamp(6999.0), 0);
        assert_eq!(parser.find_index_at_timestamp(7000.0), -1);
        assert!(parser.render_at_timestamp(7.0).is_none());
    }

    #[test]
    fn clear_screen_is_not_reported_as_a_render_failure() {
        let framed = encode_dv_frame(90_000, &build_page_only(0, false));
        let mut parser = DvbParser::new();

        parser.parse(&framed);

        assert!(parser.render_at_index(0).is_none());
        assert_eq!(parser.last_render_issue(), "");
    }

    #[test]
    fn zero_page_timeout_expires_immediately() {
        let mut payload = build_page_only(0, false);
        payload[8] = 0;
        let framed = encode_dv_frame(90_000, &payload);
        let mut parser = DvbParser::new();

        parser.parse(&framed);

        assert_eq!(parser.get_cue_end_time(0), 1000.0);
        assert_eq!(parser.find_index_at_timestamp(1000.0), -1);
    }

    #[test]
    fn acquisition_state_discards_inherited_region_state() {
        let mut framed = encode_dv_frame(90_000, &build_simple_display_set());
        framed.extend(encode_dv_frame(
            180_000,
            &build_page_only(super::super::segment::PAGE_STATE_ACQUISITION, true),
        ));
        let mut parser = DvbParser::new();

        parser.parse(&framed);

        assert_eq!(parser.count(), 2);
        assert!(parser.render_at_index(0).is_some());
        assert!(parser.render_at_index(1).is_none());
    }

    #[test]
    fn region_version_update_without_fill_preserves_pixels() {
        let mut framed = encode_dv_frame(90_000, &build_simple_display_set());
        let mut payload = build_page_only(0, true);
        payload.truncate(payload.len() - 7); // remove EDS and stuffing
        let region = vec![
            0x01, 0x10, // region 1, version 1, fill disabled
            0x00, 0x04, 0x00, 0x02, // 4x2
            0x0C, 0x00, 0x00, 0x00, // 8-bit, CLUT 0, background 0
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // object 1 at (0, 0)
        ];
        payload.extend(segment(REGION_COMPOSITION, 1, &region));
        payload.extend(segment(END_OF_DISPLAY_SET, 1, &[]));
        payload.push(0xFF);
        framed.extend(encode_dv_frame(180_000, &payload));
        let mut parser = DvbParser::new();

        parser.parse(&framed);
        let first = parser.render_at_index(0).expect("first frame");
        let second = parser.render_at_index(1).expect("second frame");

        assert_eq!(first.compositions[0].rgba, second.compositions[0].rgba);
    }

    #[test]
    fn incomplete_display_set_is_not_published_before_eds() {
        let mut payload = build_simple_display_set();
        payload.truncate(payload.len() - 7); // remove EDS and stuffing
        let first = encode_dv_frame(90_000, &payload);
        let mut ending = vec![0x20, 0x00];
        ending.extend(segment(END_OF_DISPLAY_SET, 1, &[]));
        ending.push(0xFF);
        let second = encode_dv_frame(90_000, &ending);
        let mut parser = DvbParser::new();

        assert_eq!(parser.feed(&first), 0);
        assert_eq!(parser.count(), 0);
        assert_eq!(parser.feed(&second), 1);
        assert!(parser.render_at_index(0).is_some());
    }
}
