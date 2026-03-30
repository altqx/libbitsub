//! Matroska subtitle extraction for embedded VobSub tracks.

use miniz_oxide::inflate::decompress_to_vec_zlib;
use std::fmt::Write;

const EBML_ID_SEGMENT: u32 = 0x1853_8067;
const EBML_ID_SEGMENT_INFO: u32 = 0x1549_A966;
const EBML_ID_TRACKS: u32 = 0x1654_AE6B;
const EBML_ID_TRACK_ENTRY: u32 = 0xAE;
const EBML_ID_TRACK_NUMBER: u32 = 0xD7;
const EBML_ID_TRACK_TYPE: u32 = 0x83;
const EBML_ID_CODEC_ID: u32 = 0x86;
const EBML_ID_CODEC_PRIVATE: u32 = 0x63A2;
const EBML_ID_LANGUAGE: u32 = 0x22B5_9C;
const EBML_ID_LANGUAGE_IETF: u32 = 0x22B5_9D;
const EBML_ID_NAME: u32 = 0x536E;
const EBML_ID_CONTENT_ENCODINGS: u32 = 0x6D80;
const EBML_ID_CONTENT_ENCODING: u32 = 0x6240;
const EBML_ID_CONTENT_COMPRESSION: u32 = 0x5034;
const EBML_ID_CONTENT_COMP_ALGO: u32 = 0x4254;
const EBML_ID_CONTENT_COMP_SETTINGS: u32 = 0x4255;
const EBML_ID_TIMECODE_SCALE: u32 = 0x002A_D7B1;
const EBML_ID_CLUSTER: u32 = 0x1F43_B675;
const EBML_ID_CLUSTER_TIMESTAMP: u32 = 0xE7;
const EBML_ID_BLOCK_GROUP: u32 = 0xA0;
const EBML_ID_BLOCK: u32 = 0xA1;
const EBML_ID_SIMPLE_BLOCK: u32 = 0xA3;

const MATROSKA_SUBTITLE_TRACK_TYPE: u64 = 0x11;
const MAX_CODEC_PRIVATE_SIZE: usize = 1 << 16;
const MAX_BLOCK_PAYLOAD_SIZE: usize = 1 << 20;
const MAX_TRACK_FRAMES: usize = 65_536;
const MPEG_PACK_HEADER: [u8; 14] = [
    0x00, 0x00, 0x01, 0xBA, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x00, 0x00, 0x03, 0xF8,
];

#[derive(Debug, Clone)]
pub struct ExtractedVobSub {
    pub idx_content: String,
    pub sub_data: Vec<u8>,
    pub language: Option<String>,
    pub track_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ParsedTrack {
    track_num: u64,
    codec_id: String,
    language: Option<String>,
    name: Option<String>,
    codec_private: Vec<u8>,
    compression: TrackCompression,
}

#[derive(Debug, Clone, Default)]
enum TrackCompression {
    #[default]
    None,
    Zlib,
    HeaderStrip(Vec<u8>),
}

#[derive(Debug, Clone)]
struct TrackFrame {
    timestamp_ms: u32,
    payload: Vec<u8>,
}

#[derive(Debug, Clone)]
struct SegmentBounds {
    data_start: usize,
    data_end: usize,
}

pub fn extract_vobsub_from_mks(data: &[u8]) -> Result<ExtractedVobSub, String> {
    let segment = find_segment(data)?;
    let mut timescale_ns = 1_000_000u64;
    let tracks = parse_segment_headers(data, &segment, &mut timescale_ns)?;

    let selected_track = tracks
        .into_iter()
        .find(|track| track.codec_id == "S_VOBSUB")
        .ok_or_else(|| "No S_VOBSUB track found in Matroska subtitle container".to_string())?;

    let mut frames = parse_segment_clusters(data, &segment, &selected_track, timescale_ns)?;
    if frames.is_empty() {
        return Err("Selected S_VOBSUB track contained no subtitle blocks".to_string());
    }

    frames.sort_by_key(|frame| frame.timestamp_ms);

    let mut sub_data = Vec::new();
    let mut idx_content = normalize_idx_header(&selected_track.codec_private);

    for frame in &frames {
        let file_position = sub_data.len() as u64;
        append_ps_pes_packet(&mut sub_data, frame.timestamp_ms, 0x20, &frame.payload)?;
        let _ = writeln!(
            idx_content,
            "timestamp: {}, filepos: {:08X}",
            format_timestamp(frame.timestamp_ms),
            file_position
        );
    }

    Ok(ExtractedVobSub {
        idx_content,
        sub_data,
        language: selected_track.language.filter(|value| !value.is_empty()),
        track_id: Some(
            selected_track
                .name
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| selected_track.track_num.to_string()),
        ),
    })
}

fn find_segment(data: &[u8]) -> Result<SegmentBounds, String> {
    let mut pos = 0usize;

    while pos < data.len() {
        let (id, id_len) =
            read_element_id(data, pos).ok_or_else(|| "Invalid EBML element ID".to_string())?;
        let size_pos = pos + id_len;
        let (size, size_len) = read_size_vint(data, size_pos)
            .ok_or_else(|| "Invalid EBML element size".to_string())?;
        let data_start = size_pos + size_len;
        let data_end = match size {
            Some(size) => data_start
                .checked_add(size as usize)
                .filter(|end| *end <= data.len())
                .ok_or_else(|| "Truncated Matroska element payload".to_string())?,
            None => data.len(),
        };

        if id == EBML_ID_SEGMENT {
            return Ok(SegmentBounds {
                data_start,
                data_end,
            });
        }

        pos = data_end;
    }

    Err("Matroska Segment element not found".to_string())
}

fn parse_segment_headers(
    data: &[u8],
    segment: &SegmentBounds,
    timescale_ns: &mut u64,
) -> Result<Vec<ParsedTrack>, String> {
    let mut tracks = Vec::new();
    let mut pos = segment.data_start;

    while pos < segment.data_end {
        let (id, data_start, data_end) = next_element(data, pos, segment.data_end)?;

        match id {
            EBML_ID_SEGMENT_INFO => parse_segment_info(data, data_start, data_end, timescale_ns)?,
            EBML_ID_TRACKS => parse_tracks(data, data_start, data_end, &mut tracks)?,
            _ => {}
        }

        pos = data_end;
    }

    Ok(tracks)
}

fn parse_segment_info(
    data: &[u8],
    start: usize,
    end: usize,
    timescale_ns: &mut u64,
) -> Result<(), String> {
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;
        if id == EBML_ID_TIMECODE_SCALE {
            *timescale_ns = read_uint(data, data_start, data_end)?;
        }
        pos = data_end;
    }

    Ok(())
}

fn parse_tracks(
    data: &[u8],
    start: usize,
    end: usize,
    tracks: &mut Vec<ParsedTrack>,
) -> Result<(), String> {
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;
        if id == EBML_ID_TRACK_ENTRY {
            let track = parse_track_entry(data, data_start, data_end)?;
            if track.codec_id == "S_VOBSUB" {
                tracks.push(track);
            }
        }
        pos = data_end;
    }

    Ok(())
}

fn parse_track_entry(data: &[u8], start: usize, end: usize) -> Result<ParsedTrack, String> {
    let mut track = ParsedTrack::default();
    let mut track_type = 0u64;
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;

        match id {
            EBML_ID_TRACK_NUMBER => track.track_num = read_uint(data, data_start, data_end)?,
            EBML_ID_TRACK_TYPE => track_type = read_uint(data, data_start, data_end)?,
            EBML_ID_CODEC_ID => track.codec_id = read_string(data, data_start, data_end),
            EBML_ID_CODEC_PRIVATE => {
                let size = data_end - data_start;
                if size > MAX_CODEC_PRIVATE_SIZE {
                    return Err("Matroska CodecPrivate exceeds supported size limit".to_string());
                }
                track.codec_private = data[data_start..data_end].to_vec();
            }
            EBML_ID_LANGUAGE => track.language = Some(read_string(data, data_start, data_end)),
            EBML_ID_LANGUAGE_IETF => track.language = Some(read_string(data, data_start, data_end)),
            EBML_ID_NAME => track.name = Some(read_string(data, data_start, data_end)),
            EBML_ID_CONTENT_ENCODINGS => {
                track.compression = parse_content_encodings(data, data_start, data_end)?;
            }
            _ => {}
        }

        pos = data_end;
    }

    if track_type != MATROSKA_SUBTITLE_TRACK_TYPE || track.track_num == 0 {
        return Ok(ParsedTrack::default());
    }

    Ok(track)
}

fn parse_segment_clusters(
    data: &[u8],
    segment: &SegmentBounds,
    selected_track: &ParsedTrack,
    timescale_ns: u64,
) -> Result<Vec<TrackFrame>, String> {
    let mut frames = Vec::new();
    let mut pos = segment.data_start;

    while pos < segment.data_end {
        let (id, data_start, data_end) = next_element(data, pos, segment.data_end)?;
        if id == EBML_ID_CLUSTER {
            parse_cluster(
                data,
                data_start,
                data_end,
                selected_track,
                timescale_ns,
                &mut frames,
            )?;
        }
        pos = data_end;
    }

    Ok(frames)
}

fn parse_cluster(
    data: &[u8],
    start: usize,
    end: usize,
    selected_track: &ParsedTrack,
    timescale_ns: u64,
    frames: &mut Vec<TrackFrame>,
) -> Result<(), String> {
    let mut cluster_timestamp = 0i64;
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;

        match id {
            EBML_ID_CLUSTER_TIMESTAMP => {
                cluster_timestamp = read_uint(data, data_start, data_end)? as i64;
            }
            EBML_ID_SIMPLE_BLOCK => {
                if let Some(frame) = parse_block(
                    &data[data_start..data_end],
                    selected_track,
                    cluster_timestamp,
                    timescale_ns,
                )? {
                    push_frame(frames, frame)?;
                }
            }
            EBML_ID_BLOCK_GROUP => {
                if let Some(frame) = parse_block_group(
                    data,
                    data_start,
                    data_end,
                    selected_track,
                    cluster_timestamp,
                    timescale_ns,
                )? {
                    push_frame(frames, frame)?;
                }
            }
            _ => {}
        }

        pos = data_end;
    }

    Ok(())
}

fn parse_block_group(
    data: &[u8],
    start: usize,
    end: usize,
    selected_track: &ParsedTrack,
    cluster_timestamp: i64,
    timescale_ns: u64,
) -> Result<Option<TrackFrame>, String> {
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;
        if id == EBML_ID_BLOCK {
            return parse_block(
                &data[data_start..data_end],
                selected_track,
                cluster_timestamp,
                timescale_ns,
            );
        }
        pos = data_end;
    }

    Ok(None)
}

fn parse_block(
    data: &[u8],
    selected_track: &ParsedTrack,
    cluster_timestamp: i64,
    timescale_ns: u64,
) -> Result<Option<TrackFrame>, String> {
    let (track_num, track_num_len) =
        read_vint(data, 0).ok_or_else(|| "Invalid Matroska block track number".to_string())?;

    if track_num != selected_track.track_num {
        return Ok(None);
    }

    if data.len() < track_num_len + 3 {
        return Err("Truncated Matroska block header".to_string());
    }

    let relative_timestamp =
        i16::from_be_bytes([data[track_num_len], data[track_num_len + 1]]) as i64;
    let flags = data[track_num_len + 2];
    if (flags & 0x06) != 0 {
        return Err("Laced Matroska VobSub blocks are not supported".to_string());
    }

    let payload = &data[track_num_len + 3..];
    if payload.is_empty() {
        return Ok(None);
    }
    if payload.len() > MAX_BLOCK_PAYLOAD_SIZE {
        return Err("Matroska subtitle block exceeds supported size limit".to_string());
    }

    let absolute_ticks = cluster_timestamp.saturating_add(relative_timestamp);
    if absolute_ticks < 0 {
        return Err("Matroska subtitle block timestamp underflowed before zero".to_string());
    }

    let timestamp_ms = timestamp_to_ms(absolute_ticks as u64, timescale_ns)?;

    Ok(Some(TrackFrame {
        timestamp_ms,
        payload: decode_track_payload(payload, &selected_track.compression)?,
    }))
}

fn parse_content_encodings(
    data: &[u8],
    start: usize,
    end: usize,
) -> Result<TrackCompression, String> {
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;
        if id == EBML_ID_CONTENT_ENCODING {
            let compression = parse_content_encoding(data, data_start, data_end)?;
            if !matches!(compression, TrackCompression::None) {
                return Ok(compression);
            }
        }
        pos = data_end;
    }

    Ok(TrackCompression::None)
}

fn parse_content_encoding(
    data: &[u8],
    start: usize,
    end: usize,
) -> Result<TrackCompression, String> {
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;
        if id == EBML_ID_CONTENT_COMPRESSION {
            return parse_content_compression(data, data_start, data_end);
        }
        pos = data_end;
    }

    Ok(TrackCompression::None)
}

fn parse_content_compression(
    data: &[u8],
    start: usize,
    end: usize,
) -> Result<TrackCompression, String> {
    if start == end {
        return Ok(TrackCompression::Zlib);
    }

    let mut algo = 0u64;
    let mut settings = None;
    let mut pos = start;

    while pos < end {
        let (id, data_start, data_end) = next_element(data, pos, end)?;
        match id {
            EBML_ID_CONTENT_COMP_ALGO => algo = read_uint(data, data_start, data_end)?,
            EBML_ID_CONTENT_COMP_SETTINGS => settings = Some(data[data_start..data_end].to_vec()),
            _ => {}
        }
        pos = data_end;
    }

    match algo {
        0 => Ok(TrackCompression::Zlib),
        3 => Ok(TrackCompression::HeaderStrip(settings.unwrap_or_default())),
        other => Err(format!(
            "Unsupported Matroska content compression algorithm: {other}"
        )),
    }
}

fn decode_track_payload(payload: &[u8], compression: &TrackCompression) -> Result<Vec<u8>, String> {
    match compression {
        TrackCompression::None => Ok(payload.to_vec()),
        TrackCompression::Zlib => decompress_to_vec_zlib(payload)
            .map_err(|_| "Failed to inflate zlib-compressed Matroska subtitle block".to_string()),
        TrackCompression::HeaderStrip(prefix) => {
            let mut out = Vec::with_capacity(prefix.len() + payload.len());
            out.extend_from_slice(prefix);
            out.extend_from_slice(payload);
            Ok(out)
        }
    }
}

fn push_frame(frames: &mut Vec<TrackFrame>, frame: TrackFrame) -> Result<(), String> {
    if frames.len() >= MAX_TRACK_FRAMES {
        return Err("Matroska subtitle track exceeds supported frame count".to_string());
    }
    frames.push(frame);
    Ok(())
}

fn normalize_idx_header(codec_private: &[u8]) -> String {
    let mut header = String::new();
    let text = String::from_utf8_lossy(codec_private)
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    for line in text.lines() {
        let trimmed = line.trim_matches(char::from(0)).trim();
        if trimmed.is_empty() || trimmed.starts_with("timestamp:") {
            continue;
        }
        header.push_str(trimmed);
        header.push('\n');
    }

    header
}

fn append_ps_pes_packet(
    out: &mut Vec<u8>,
    timestamp_ms: u32,
    sub_stream_id: u8,
    payload: &[u8],
) -> Result<(), String> {
    let pes_length = payload
        .len()
        .checked_add(9)
        .ok_or_else(|| "VobSub PES payload length overflowed".to_string())?;
    if pes_length > u16::MAX as usize {
        return Err("VobSub payload exceeds maximum PES packet length".to_string());
    }

    out.extend_from_slice(&MPEG_PACK_HEADER);
    out.extend_from_slice(&[0x00, 0x00, 0x01, 0xBD]);
    out.extend_from_slice(&(pes_length as u16).to_be_bytes());
    out.extend_from_slice(&[0x80, 0x80, 0x05]);
    out.extend_from_slice(&encode_pts(timestamp_ms as u64 * 90));
    out.push(sub_stream_id);
    out.extend_from_slice(payload);
    Ok(())
}

fn encode_pts(pts: u64) -> [u8; 5] {
    let pts = pts & 0x1FFF_FFFFF;
    [
        (((pts >> 30) as u8 & 0x07) << 1) | 0x21,
        ((pts >> 22) & 0xFF) as u8,
        ((((pts >> 15) & 0x7F) as u8) << 1) | 0x01,
        ((pts >> 7) & 0xFF) as u8,
        (((pts & 0x7F) as u8) << 1) | 0x01,
    ]
}

fn timestamp_to_ms(timestamp_ticks: u64, timescale_ns: u64) -> Result<u32, String> {
    let value = (timestamp_ticks as u128)
        .checked_mul(timescale_ns as u128)
        .ok_or_else(|| "Matroska subtitle timestamp overflowed".to_string())?
        / 1_000_000u128;
    Ok(value.min(u32::MAX as u128) as u32)
}

fn format_timestamp(timestamp_ms: u32) -> String {
    let hours = timestamp_ms / 3_600_000;
    let minutes = (timestamp_ms % 3_600_000) / 60_000;
    let seconds = (timestamp_ms % 60_000) / 1_000;
    let millis = timestamp_ms % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}:{millis:03}")
}

fn next_element(data: &[u8], pos: usize, limit: usize) -> Result<(u32, usize, usize), String> {
    let (id, id_len) =
        read_element_id(data, pos).ok_or_else(|| "Invalid EBML element ID".to_string())?;
    let size_pos = pos + id_len;
    let (size, size_len) =
        read_size_vint(data, size_pos).ok_or_else(|| "Invalid EBML element size".to_string())?;
    let data_start = size_pos + size_len;
    let data_end = match size {
        Some(size) => data_start
            .checked_add(size as usize)
            .filter(|end| *end <= limit)
            .ok_or_else(|| "Truncated Matroska element payload".to_string())?,
        None => limit,
    };
    Ok((id, data_start, data_end))
}

fn read_uint(data: &[u8], start: usize, end: usize) -> Result<u64, String> {
    let size = end.saturating_sub(start);
    if size == 0 || size > 8 {
        return Err("Unsupported EBML integer size".to_string());
    }

    let mut value = 0u64;
    for &byte in &data[start..end] {
        value = (value << 8) | byte as u64;
    }
    Ok(value)
}

fn read_string(data: &[u8], start: usize, end: usize) -> String {
    String::from_utf8_lossy(&data[start..end])
        .trim_matches(char::from(0))
        .trim()
        .to_string()
}

fn read_element_id(data: &[u8], pos: usize) -> Option<(u32, usize)> {
    let first = *data.get(pos)?;
    let width = vint_width(first)?;
    if width > 4 || pos + width > data.len() {
        return None;
    }

    let mut value = first as u32;
    for &byte in &data[pos + 1..pos + width] {
        value = (value << 8) | byte as u32;
    }

    Some((value, width))
}

fn read_size_vint(data: &[u8], pos: usize) -> Option<(Option<u64>, usize)> {
    let (value, width) = read_vint(data, pos)?;
    let unknown_value = if width == 8 {
        u64::MAX >> 8
    } else {
        (1u64 << (width * 7)) - 1
    };

    if value == unknown_value {
        Some((None, width))
    } else {
        Some((Some(value), width))
    }
}

fn read_vint(data: &[u8], pos: usize) -> Option<(u64, usize)> {
    let first = *data.get(pos)?;
    let width = vint_width(first)?;
    if pos + width > data.len() {
        return None;
    }

    let mask = if width == 8 {
        0
    } else {
        (1u8 << (8 - width)) - 1
    };
    let mut value = (first & mask) as u64;
    for &byte in &data[pos + 1..pos + width] {
        value = (value << 8) | byte as u64;
    }

    Some((value, width))
}

fn vint_width(first: u8) -> Option<usize> {
    if first & 0x80 != 0 {
        Some(1)
    } else if first & 0x40 != 0 {
        Some(2)
    } else if first & 0x20 != 0 {
        Some(3)
    } else if first & 0x10 != 0 {
        Some(4)
    } else if first & 0x08 != 0 {
        Some(5)
    } else if first & 0x04 != 0 {
        Some(6)
    } else if first & 0x02 != 0 {
        Some(7)
    } else if first & 0x01 != 0 {
        Some(8)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vobsub::{VobSubParser, parse_idx, parse_subtitle_packet};
    use memchr::memchr;

    #[test]
    fn extracts_embedded_vobsub_track_from_mks() {
        let idx_content = include_str!("../testfiles/vobsub.idx");
        let sub_data = include_bytes!("../testfiles/vobsub.sub");
        let idx_header = extract_idx_header(idx_content);
        let payload = extract_first_spu_payload(sub_data);
        let mks = build_test_mks(&idx_header, &payload, 1_000, "eng", 1);

        let extracted = extract_vobsub_from_mks(&mks).expect("expected embedded VobSub track");
        let idx = parse_idx(&extracted.idx_content);

        assert_eq!(idx.timestamps.len(), 1);
        assert_eq!(idx.timestamps[0].timestamp_ms, 1_000);
        assert_eq!(extracted.language.as_deref(), Some("eng"));
        assert_eq!(extracted.track_id.as_deref(), Some("1"));

        let packet = parse_subtitle_packet(
            &extracted.sub_data,
            idx.timestamps[0].file_position as usize,
            &idx.palette,
        )
        .expect("expected extracted .sub packet to parse");

        assert!(packet.0.width > 0);
        assert!(packet.0.height > 0);
    }

    #[test]
    fn loads_mks_via_vobsub_parser() {
        let idx_content = include_str!("../testfiles/vobsub.idx");
        let sub_data = include_bytes!("../testfiles/vobsub.sub");
        let idx_header = extract_idx_header(idx_content);
        let payload = extract_first_spu_payload(sub_data);
        let mks = build_test_mks(&idx_header, &payload, 2_500, "eng", 1);

        let mut parser = VobSubParser::new();
        parser
            .load_from_mks(&mks)
            .expect("expected MKS parsing to succeed");

        assert_eq!(parser.count(), 1);
        assert_eq!(parser.language(), "eng");
        assert_eq!(parser.track_id(), "1");
        assert!(parser.has_idx_metadata());
        assert_eq!(parser.get_cue_start_time(0), 2500.0);

        let frame = parser
            .render_at_index(0)
            .expect("expected decoded VobSub frame");
        assert!(frame.width() > 0);
        assert!(frame.height() > 0);
    }

    #[test]
    fn parses_real_mks_fixture() {
        let mks_data = include_bytes!("../testfiles/vobsub.mks");

        let extracted =
            extract_vobsub_from_mks(mks_data).expect("expected real MKS fixture to extract");
        let idx = parse_idx(&extracted.idx_content);

        assert!(!idx.timestamps.is_empty());
        assert!(!extracted.sub_data.is_empty());
        assert!(idx.metadata.width > 0);
        assert!(idx.metadata.height > 0);

        let first_packet = parse_subtitle_packet(
            &extracted.sub_data,
            idx.timestamps[0].file_position as usize,
            &idx.palette,
        )
        .expect("expected first extracted packet from real fixture to parse");

        assert!(first_packet.0.width > 0);
        assert!(first_packet.0.height > 0);

        let mut parser = VobSubParser::new();
        parser
            .load_from_mks(mks_data)
            .expect("expected real MKS fixture to load through VobSubParser");

        assert_eq!(parser.count(), idx.timestamps.len());
        assert_eq!(
            parser.get_cue_start_time(0),
            idx.timestamps[0].timestamp_ms as f64
        );

        let frame = parser
            .render_at_index(0)
            .expect("expected first cue from real MKS fixture to render");
        assert!(frame.width() > 0);
        assert!(frame.height() > 0);
    }

    fn extract_idx_header(idx_content: &str) -> String {
        let mut header = String::new();
        for line in idx_content.lines() {
            if line.trim_start().starts_with("timestamp:") {
                break;
            }
            if line.trim().is_empty() {
                continue;
            }
            header.push_str(line);
            header.push('\n');
        }
        header
    }

    fn extract_first_spu_payload(sub_data: &[u8]) -> Vec<u8> {
        let mut offset = 0usize;
        let len = sub_data.len();
        let mut chunks = Vec::new();
        let mut expected_size = 0usize;
        let mut collected = 0usize;

        while offset < len.saturating_sub(4) {
            let Some(pos) = memchr(0x00, &sub_data[offset..]) else {
                break;
            };
            let candidate = offset + pos;
            if candidate + 3 >= len
                || sub_data[candidate + 1] != 0x00
                || sub_data[candidate + 2] != 0x01
            {
                offset = candidate + 1;
                continue;
            }

            let stream_id = sub_data[candidate + 3];
            offset = candidate + 4;

            if stream_id == 0xBA {
                if offset < len && (sub_data[offset] & 0xC0) == 0x40 {
                    offset += 9;
                    let stuffing = sub_data[offset] as usize & 0x07;
                    offset += 1 + stuffing;
                } else {
                    offset += 8;
                }
                continue;
            }

            if stream_id != 0xBD {
                if offset + 2 > len {
                    break;
                }
                let packet_len =
                    u16::from_be_bytes([sub_data[offset], sub_data[offset + 1]]) as usize;
                offset += 2 + packet_len;
                continue;
            }

            if offset + 2 > len {
                break;
            }
            let packet_len = u16::from_be_bytes([sub_data[offset], sub_data[offset + 1]]) as usize;
            offset += 2;
            let packet_end = offset + packet_len;

            let header_data_len = sub_data[offset + 2] as usize;
            offset += 3 + header_data_len;
            offset += 1;

            let payload = &sub_data[offset..packet_end];
            if expected_size == 0 && payload.len() >= 2 {
                expected_size = u16::from_be_bytes([payload[0], payload[1]]) as usize;
            }
            collected += payload.len();
            chunks.extend_from_slice(payload);

            if expected_size > 0 && collected >= expected_size {
                chunks.truncate(expected_size);
                return chunks;
            }

            offset = packet_end;
        }

        panic!("failed to extract raw VobSub payload from test fixture")
    }

    fn build_test_mks(
        idx_header: &str,
        payload: &[u8],
        timestamp_ms: u64,
        language: &str,
        track_num: u64,
    ) -> Vec<u8> {
        let ebml_header = element(0x1A45_DFA3, &element(0x4286, &[0x01]));

        let info = element(
            EBML_ID_SEGMENT_INFO,
            &element(EBML_ID_TIMECODE_SCALE, &[0x0F, 0x42, 0x40]),
        );

        let track_entry = element(
            EBML_ID_TRACK_ENTRY,
            &[
                element(EBML_ID_TRACK_NUMBER, &[track_num as u8]),
                element(EBML_ID_TRACK_TYPE, &[MATROSKA_SUBTITLE_TRACK_TYPE as u8]),
                element(EBML_ID_CODEC_ID, b"S_VOBSUB"),
                element(EBML_ID_CODEC_PRIVATE, idx_header.as_bytes()),
                element(EBML_ID_LANGUAGE, language.as_bytes()),
            ]
            .concat(),
        );
        let tracks = element(EBML_ID_TRACKS, &track_entry);

        let cluster = element(
            EBML_ID_CLUSTER,
            &[
                element(EBML_ID_CLUSTER_TIMESTAMP, &encode_uint(timestamp_ms)),
                element(
                    EBML_ID_SIMPLE_BLOCK,
                    &build_simple_block(track_num, 0, payload),
                ),
            ]
            .concat(),
        );

        let segment = element(EBML_ID_SEGMENT, &[info, tracks, cluster].concat());
        [ebml_header, segment].concat()
    }

    fn build_simple_block(track_num: u64, relative_timestamp: i16, payload: &[u8]) -> Vec<u8> {
        let mut block = encode_track_number(track_num);
        block.extend_from_slice(&relative_timestamp.to_be_bytes());
        block.push(0x80);
        block.extend_from_slice(payload);
        block
    }

    fn element(id: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = encode_element_id(id);
        out.extend_from_slice(&encode_size(payload.len() as u64));
        out.extend_from_slice(payload);
        out
    }

    fn encode_element_id(id: u32) -> Vec<u8> {
        if id > 0x00FF_FFFF {
            vec![
                ((id >> 24) & 0xFF) as u8,
                ((id >> 16) & 0xFF) as u8,
                ((id >> 8) & 0xFF) as u8,
                (id & 0xFF) as u8,
            ]
        } else if id > 0x0000_FFFF {
            vec![
                ((id >> 16) & 0xFF) as u8,
                ((id >> 8) & 0xFF) as u8,
                (id & 0xFF) as u8,
            ]
        } else if id > 0x0000_00FF {
            vec![((id >> 8) & 0xFF) as u8, (id & 0xFF) as u8]
        } else {
            vec![id as u8]
        }
    }

    fn encode_size(value: u64) -> Vec<u8> {
        for width in 1..=8 {
            let max_value = if width == 8 {
                u64::MAX >> 8
            } else {
                (1u64 << (width * 7)) - 2
            };
            if value <= max_value {
                let mut bytes = vec![0u8; width];
                let mut temp = value;
                for index in (0..width).rev() {
                    bytes[index] = (temp & 0xFF) as u8;
                    temp >>= 8;
                }
                bytes[0] |= 1 << (8 - width);
                return bytes;
            }
        }

        panic!("size too large for EBML vint encoding")
    }

    fn encode_track_number(track_num: u64) -> Vec<u8> {
        if track_num == 0 || track_num >= 0x7F {
            panic!("test track number must fit in a one-byte block vint")
        }
        vec![0x80 | track_num as u8]
    }

    fn encode_uint(value: u64) -> Vec<u8> {
        if value == 0 {
            return vec![0];
        }

        let bytes = value.to_be_bytes();
        let first_non_zero = bytes
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(bytes.len() - 1);
        bytes[first_non_zero..].to_vec()
    }
}
