//! PES / ES framing and `"DV"` PTS-framed dump parsing.

use super::segment::{STUFFING, SYNC_BYTE, Segment};

/// libbitsub DVB dump magic: `"DV"`.
pub const DV_MAGIC: [u8; 2] = [b'D', b'V'];

#[derive(Debug, Clone)]
pub struct TimedPayload {
    /// Presentation timestamp in milliseconds.
    pub pts_ms: u32,
    /// PES data field or raw segment bytes.
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedParseAttempt {
    Complete(usize),
    Incomplete,
    Invalid,
}

/// Convert a 90 kHz PTS tick value to milliseconds.
#[inline]
pub fn pts_90k_to_ms(pts_90k: u64) -> u32 {
    (pts_90k / 90) as u32
}

/// True when `data` looks like a libbitsub `"DV"` framed dump or DVB PES/ES.
pub fn looks_like_dvb(data: &[u8]) -> bool {
    if data.len() >= 10 && data[0] == DV_MAGIC[0] && data[1] == DV_MAGIC[1] {
        let payload_len = u32::from_be_bytes([data[6], data[7], data[8], data[9]]) as usize;
        if payload_len > 0 && data.len() >= 10 + payload_len.min(64) {
            let payload = &data[10..];
            return looks_like_dvb_payload(payload);
        }
    }

    if looks_like_mpeg_pes_dvb(data) {
        return true;
    }

    looks_like_dvb_payload(data)
}

fn looks_like_dvb_payload(data: &[u8]) -> bool {
    let mut offset = 0usize;

    // Optional PES data field prefix.
    if data.len() >= 3 && data[0] == 0x20 && data[1] == 0x00 && data[2] == SYNC_BYTE {
        offset = 2;
    }

    if offset >= data.len() || data[offset] != SYNC_BYTE {
        return false;
    }

    let mut known = 0u32;
    while offset + 6 <= data.len() {
        if data[offset] == STUFFING {
            break;
        }
        if data[offset] != SYNC_BYTE {
            break;
        }

        let segment_type = data[offset + 1];
        let length = u16::from_be_bytes([data[offset + 4], data[offset + 5]]) as usize;
        let total = 6 + length;
        if offset + total > data.len() {
            break;
        }

        if Segment::is_known_type(segment_type) {
            known += 1;
            if known >= 2 || segment_type == super::segment::PAGE_COMPOSITION {
                return true;
            }
        }

        offset += total;
    }

    known > 0
}

fn looks_like_mpeg_pes_dvb(data: &[u8]) -> bool {
    if data.len() < 9 {
        return false;
    }
    let limit = data.len().saturating_sub(9).min(65_536);
    let mut index = 0usize;

    while index <= limit {
        if data[index] == 0x00
            && data.get(index + 1) == Some(&0x00)
            && data.get(index + 2) == Some(&0x01)
            && data.get(index + 3) == Some(&0xBD)
        {
            if let Some(payload) = extract_pes_payload(&data[index..]) {
                if looks_like_dvb_payload(payload) {
                    return true;
                }
            }
        }
        index += 1;
    }

    false
}

/// Parse as many complete timed units as possible from `data`.
/// Returns `(units, bytes_consumed)`.
pub fn parse_timed_stream(data: &[u8]) -> (Vec<TimedPayload>, usize) {
    if data.is_empty() {
        return (Vec::new(), 0);
    }

    if data.len() >= 2 && data[0] == DV_MAGIC[0] && data[1] == DV_MAGIC[1] {
        return parse_dv_framed(data);
    }

    if let Some(pes_start) = find_pes_start(data) {
        let (units, consumed) = parse_mpeg_pes_stream(&data[pes_start..]);
        return (units, pes_start + consumed);
    }

    // Raw ES without timestamps cannot form cues.
    (Vec::new(), 0)
}

fn parse_dv_framed(data: &[u8]) -> (Vec<TimedPayload>, usize) {
    let mut units = Vec::new();
    let mut offset = 0usize;

    while offset + 10 <= data.len() {
        if data[offset] != DV_MAGIC[0] || data[offset + 1] != DV_MAGIC[1] {
            break;
        }

        let pts_90k = u32::from_be_bytes([
            data[offset + 2],
            data[offset + 3],
            data[offset + 4],
            data[offset + 5],
        ]);
        let payload_len = u32::from_be_bytes([
            data[offset + 6],
            data[offset + 7],
            data[offset + 8],
            data[offset + 9],
        ]) as usize;

        let Some(frame_end) = offset
            .checked_add(10)
            .and_then(|payload_start| payload_start.checked_add(payload_len))
        else {
            break;
        };
        if frame_end > data.len() {
            break;
        }

        let payload = data[offset + 10..frame_end].to_vec();
        units.push(TimedPayload {
            pts_ms: pts_90k_to_ms(u64::from(pts_90k)),
            payload,
        });
        offset = frame_end;
    }

    (units, offset)
}

fn parse_mpeg_pes_stream(data: &[u8]) -> (Vec<TimedPayload>, usize) {
    let mut units = Vec::new();
    let mut offset = 0usize;

    while offset + 9 <= data.len() {
        if !(data[offset] == 0x00
            && data[offset + 1] == 0x00
            && data[offset + 2] == 0x01
            && data[offset + 3] == 0xBD)
        {
            // Resync
            if let Some(rel) = find_pes_start(&data[offset..]) {
                offset += rel;
                continue;
            }
            break;
        }

        let packet_length = u16::from_be_bytes([data[offset + 4], data[offset + 5]]) as usize;
        let total = 6 + packet_length;
        if offset + total > data.len() {
            break;
        }

        let packet = &data[offset..offset + total];
        if let Some((pts_90k, payload)) = parse_pes_packet(packet) {
            if looks_like_dvb_payload(payload) {
                units.push(TimedPayload {
                    pts_ms: pts_90k_to_ms(pts_90k),
                    payload: payload.to_vec(),
                });
            }
        }

        offset += total;
    }

    (units, offset)
}

fn find_pes_start(data: &[u8]) -> Option<usize> {
    data.windows(4)
        .position(|window| window == [0x00, 0x00, 0x01, 0xBD])
}

fn extract_pes_payload(packet: &[u8]) -> Option<&[u8]> {
    parse_pes_packet(packet).map(|(_, payload)| payload)
}

/// Parse one PES packet starting with `00 00 01 BD`.
fn parse_pes_packet(packet: &[u8]) -> Option<(u64, &[u8])> {
    if packet.len() < 9 {
        return None;
    }
    if !(packet[0] == 0x00 && packet[1] == 0x00 && packet[2] == 0x01 && packet[3] == 0xBD) {
        return None;
    }

    let packet_length = u16::from_be_bytes([packet[4], packet[5]]) as usize;
    let packet_end = 6 + packet_length;
    if packet_length < 3 || packet.len() < packet_end {
        return None;
    }

    // Optional PES header
    let flags = packet[7];
    let header_data_length = packet[8] as usize;
    let header_end = 9 + header_data_length;
    if header_end > packet_end {
        return None;
    }

    let pts_dts_flags = (flags >> 6) & 0x03;
    let pts_90k = if pts_dts_flags >= 2 && header_data_length >= 5 {
        read_pes_pts(&packet[9..14])?
    } else {
        return None;
    };

    let payload = &packet[header_end..packet_end];
    Some((pts_90k, payload))
}

fn read_pes_pts(data: &[u8]) -> Option<u64> {
    if data.len() < 5 {
        return None;
    }
    if !matches!(data[0] & 0xF0, 0x20 | 0x30)
        || data[0] & 1 == 0
        || data[2] & 1 == 0
        || data[4] & 1 == 0
    {
        return None;
    }

    let pts = ((data[0] as u64 & 0x0E) << 29)
        | ((data[1] as u64) << 22)
        | ((data[2] as u64 & 0xFE) << 14)
        | ((data[3] as u64) << 7)
        | ((data[4] as u64) >> 1);

    Some(pts)
}

/// Strip optional `0x20 0x00` PES data-field prefix and trailing stuffing.
pub fn normalize_es_payload(payload: &[u8]) -> &[u8] {
    let mut data = payload;
    if data.len() >= 2 && data[0] == 0x20 && data[1] == 0x00 {
        data = &data[2..];
    }

    while let Some((last, rest)) = data.split_last() {
        if *last == STUFFING {
            data = rest;
        } else {
            break;
        }
    }

    data
}

/// Iterate segments inside a normalized ES payload until EDS or end.
pub fn iter_segments(payload: &[u8]) -> Vec<Segment<'_>> {
    let data = normalize_es_payload(payload);
    let mut offset = 0usize;
    let mut segments = Vec::new();

    while offset < data.len() {
        if data[offset] == STUFFING {
            break;
        }

        match Segment::parse(&data[offset..]) {
            Some((segment, consumed)) => {
                let is_end = segment.segment_type == super::segment::END_OF_DISPLAY_SET;
                segments.push(segment);
                offset += consumed;
                if is_end {
                    break;
                }
            }
            None => break,
        }
    }

    segments
}

/// Build a `"DV"` framed dump for tests / tooling.
pub fn encode_dv_frame(pts_90k: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(10 + payload.len());
    out.extend_from_slice(&DV_MAGIC);
    out.extend_from_slice(&pts_90k.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dvb::segment::{END_OF_DISPLAY_SET, PAGE_COMPOSITION, SYNC_BYTE};

    #[test]
    fn dv_framed_round_trip() {
        let payload = [
            0x20,
            0x00,
            SYNC_BYTE,
            PAGE_COMPOSITION,
            0x00,
            0x01,
            0x00,
            0x02,
            0x05,
            0x10,
            SYNC_BYTE,
            END_OF_DISPLAY_SET,
            0x00,
            0x01,
            0x00,
            0x00,
            0xFF,
        ];
        let framed = encode_dv_frame(90_000, &payload); // 1 second
        assert!(looks_like_dvb(&framed));

        let (units, consumed) = parse_timed_stream(&framed);
        assert_eq!(consumed, framed.len());
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].pts_ms, 1000);
        assert_eq!(units[0].payload, payload);
    }

    #[test]
    fn pts_conversion() {
        assert_eq!(pts_90k_to_ms(90_000), 1000);
        assert_eq!(pts_90k_to_ms(0), 0);
    }

    #[test]
    fn short_inputs_do_not_panic_during_detection() {
        for len in 0..9 {
            assert!(!looks_like_dvb(&vec![0; len]));
        }
    }

    #[test]
    fn oversized_dv_frame_length_fails_closed() {
        let frame = [b'D', b'V', 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF];
        let (units, consumed) = parse_timed_stream(&frame);
        assert!(units.is_empty());
        assert_eq!(consumed, 0);
    }

    fn encode_pes_packet(pts: u64, payload: &[u8]) -> Vec<u8> {
        let pts_bytes = [
            0x20 | (((pts >> 30) as u8 & 0x07) << 1) | 1,
            (pts >> 22) as u8,
            (((pts >> 15) as u8 & 0x7F) << 1) | 1,
            (pts >> 7) as u8,
            ((pts as u8 & 0x7F) << 1) | 1,
        ];
        let packet_length = 8usize + payload.len();
        let mut packet = vec![0x00, 0x00, 0x01, 0xBD];
        packet.extend_from_slice(&(packet_length as u16).to_be_bytes());
        packet.extend_from_slice(&[0x80, 0x80, 0x05]);
        packet.extend_from_slice(&pts_bytes);
        packet.extend_from_slice(payload);
        packet
    }

    #[test]
    fn timed_stream_resynchronizes_to_a_leading_pes_packet() {
        let payload = [
            0x20,
            0x00,
            SYNC_BYTE,
            PAGE_COMPOSITION,
            0x00,
            0x01,
            0x00,
            0x02,
            0x05,
            0x10,
        ];
        let packet = encode_pes_packet(90_000, &payload);
        let mut stream = vec![0x47, 0x00, 0xFF];
        stream.extend_from_slice(&packet);

        assert!(looks_like_dvb(&stream));
        let (units, consumed) = parse_timed_stream(&stream);
        assert_eq!(consumed, stream.len());
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].pts_ms, 1000);
    }

    #[test]
    fn preserves_the_full_33_bit_pes_timestamp() {
        let payload = [
            0x20,
            0x00,
            SYNC_BYTE,
            PAGE_COMPOSITION,
            0x00,
            0x01,
            0x00,
            0x02,
            0x05,
            0x10,
        ];
        let pts = (1u64 << 32) + 90_000;
        let packet = encode_pes_packet(pts, &payload);

        let (units, _) = parse_timed_stream(&packet);

        assert_eq!(units[0].pts_ms, (pts / 90) as u32);
    }

    #[test]
    fn malformed_pes_header_length_fails_closed() {
        let mut packet = vec![0x00, 0x00, 0x01, 0xBD, 0x00, 0x03, 0x80, 0x80, 0xFF];
        packet.resize(300, 0);

        assert!(!looks_like_dvb(&packet));
        assert!(parse_pes_packet(&packet).is_none());
    }
}
