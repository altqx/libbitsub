//! VobSub SUB file parser.
//!
//! The SUB file contains MPEG-2 Private Stream 1 packets with DVD subtitle data.

use super::VobSubPalette;

/// Parsed subtitle packet from the SUB file.
#[derive(Debug, Clone)]
pub struct SubtitlePacket {
    /// Timestamp in milliseconds (from PTS)
    pub timestamp_ms: u32,
    /// Duration in milliseconds
    pub duration_ms: u32,
    /// X position
    pub x: u16,
    /// Y position
    pub y: u16,
    /// Width
    pub width: u16,
    /// Height
    pub height: u16,
    /// 4 color indices into the 16-color palette
    pub color_indices: [u8; 4],
    /// 4 alpha values (0-15, where 0 is transparent, 15 is opaque)
    pub alpha_values: [u8; 4],
    /// RLE-encoded pixel data (even field / top field)
    pub even_field_data: Vec<u8>,
    /// RLE-encoded pixel data (odd field / bottom field)
    pub odd_field_data: Vec<u8>,
}

/// Parse a subtitle packet from the SUB file at the given position.
pub fn parse_subtitle_packet(
    data: &[u8],
    start_offset: usize,
    _palette: &VobSubPalette,
) -> Option<(SubtitlePacket, usize)> {
    let mut offset = start_offset;
    let data_len = data.len();

    // Safety: limit how far we scan for a single packet (256KB should be more than enough)
    let max_scan = (start_offset + 262144).min(data_len);

    let mut pts: u32 = 0;
    let mut data_chunks: Vec<Vec<u8>> = Vec::new();
    let mut expected_size: usize = 0;
    let mut collected_size: usize = 0;

    // Look for MPEG-2 PS headers and collect all packets
    while offset < max_scan.saturating_sub(4) {
        // Check for start code prefix (00 00 01)
        if data[offset] != 0x00 || data[offset + 1] != 0x00 || data[offset + 2] != 0x01 {
            offset += 1;
            continue;
        }

        let stream_id = data[offset + 3];

        // Pack header (0xBA)
        if stream_id == 0xBA {
            offset += 4;

            // Check MPEG-1 or MPEG-2 pack header
            if offset < data_len && (data[offset] & 0xC0) == 0x40 {
                // MPEG-2: pack header + stuffing
                offset += 9;
                if offset < data_len {
                    let stuffing = (data[offset] & 0x07) as usize;
                    offset += 1 + stuffing;
                }
            } else {
                // MPEG-1: 8 bytes
                offset += 8;
            }
            continue;
        }

        // Private Stream 1 (0xBD) - contains subtitle data
        if stream_id == 0xBD {
            offset += 4;

            if offset + 2 > data_len {
                break;
            }

            let pes_length = ((data[offset] as usize) << 8) | (data[offset + 1] as usize);
            offset += 2;

            if offset + pes_length > data_len {
                break;
            }

            // Parse PES header
            let pes_flags = data[offset + 1];
            let header_data_length = data[offset + 2] as usize;
            offset += 3;

            // Extract PTS if present and we don't have one yet
            if (pes_flags & 0x80) != 0 && pts == 0 {
                pts = extract_pts(data, offset);
            }

            offset += header_data_length;

            // Skip stream ID byte
            offset += 1;

            // Calculate payload length
            let payload_length = pes_length.saturating_sub(3 + header_data_length + 1);

            if payload_length > 0 && offset + payload_length <= data_len {
                let payload = data[offset..offset + payload_length].to_vec();

                // First packet - read expected subtitle size
                if expected_size == 0 && payload.len() >= 2 {
                    expected_size = ((payload[0] as usize) << 8) | (payload[1] as usize);
                }

                data_chunks.push(payload);
                collected_size += payload_length;
                offset += payload_length;

                // Check if we've collected enough data
                if expected_size > 0 && collected_size >= expected_size {
                    break;
                }

                continue;
            }
        }

        // Padding stream (0xBE)
        if stream_id == 0xBE {
            offset += 4;
            if offset + 2 > data_len {
                break;
            }
            let length = ((data[offset] as usize) << 8) | (data[offset + 1] as usize);
            offset += 2 + length;
            continue;
        }

        // Other stream types
        if stream_id >= 0xBC {
            if !data_chunks.is_empty() {
                break;
            }
            offset += 4;
            if offset + 2 > data_len {
                break;
            }
            let length = ((data[offset] as usize) << 8) | (data[offset + 1] as usize);
            offset += 2 + length;
            continue;
        }

        offset += 1;
    }

    // Reassemble collected data
    if data_chunks.is_empty() {
        return None;
    }

    let subtitle_data: Vec<u8> = if data_chunks.len() == 1 {
        data_chunks.into_iter().next().unwrap()
    } else {
        data_chunks.into_iter().flatten().collect()
    };

    if subtitle_data.len() < 4 {
        return None;
    }

    // Parse subtitle packet
    parse_subtitle_data(&subtitle_data, pts).map(|packet| (packet, offset))
}

/// Extract PTS (Presentation Time Stamp) from PES header.
fn extract_pts(data: &[u8], offset: usize) -> u32 {
    if offset + 5 > data.len() {
        return 0;
    }

    let pts32_30 = ((data[offset] >> 1) & 0x07) as u64;
    let pts29_15 = (((data[offset + 1] as u64) << 7) | ((data[offset + 2] >> 1) as u64)) as u64;
    let pts14_0 = (((data[offset + 3] as u64) << 7) | ((data[offset + 4] >> 1) as u64)) as u64;

    // Combine into 33-bit value
    let pts = (pts32_30 << 30) | (pts29_15 << 15) | pts14_0;

    // Convert from 90kHz clock to milliseconds
    (pts / 90) as u32
}

/// Parse the subtitle control and bitmap data.
fn parse_subtitle_data(data: &[u8], pts: u32) -> Option<SubtitlePacket> {
    if data.len() < 4 {
        return None;
    }

    let packet_start = 0;
    let end_offset = data.len();

    // First 2 bytes: total subtitle packet size
    // let _packet_size = ((data[0] as usize) << 8) | (data[1] as usize);

    // Next 2 bytes: offset to first control sequence (DCSQ offset)
    let dcsq_offset = ((data[2] as usize) << 8) | (data[3] as usize);

    // Parse control sequence
    let mut x: u16 = 0;
    let mut y: u16 = 0;
    let mut width: u16 = 0;
    let mut height: u16 = 0;
    let mut duration: u32 = 0;
    let mut found_stop: bool = false;
    let mut color_indices = [0u8, 1, 2, 3];
    let mut alpha_values = [0u8, 15, 15, 15];
    let mut top_field_offset: usize = 0;
    let mut bottom_field_offset: usize = 0;

    let mut ctrl_offset = packet_start + dcsq_offset;
    let mut iterations = 0;
    const MAX_ITERATIONS: usize = 1000; // Safety limit

    while ctrl_offset < end_offset && iterations < MAX_ITERATIONS && !found_stop {
        iterations += 1;
        
        // Remember where this block started (before reading delay/next_offset)
        let block_start = ctrl_offset;

        // Each control sequence block starts with a delay value (2 bytes)
        if ctrl_offset + 4 > end_offset {
            break;
        }

        let delay = ((data[ctrl_offset] as u32) << 8) | (data[ctrl_offset + 1] as u32);
        ctrl_offset += 2;

        // Next 2 bytes: offset to next control block
        let next_ctrl_offset =
            ((data[ctrl_offset] as usize) << 8) | (data[ctrl_offset + 1] as usize);
        ctrl_offset += 2;

        // Parse commands
        while ctrl_offset < end_offset {
            let cmd = data[ctrl_offset];
            ctrl_offset += 1;

            match cmd {
                0x00 => {} // Force display
                0x01 => {} // Start display
                0x02 => {
                    // Stop display - delay is when to stop (duration in 1024/90000 sec units)
                    duration = (delay * 1024) / 90;
                    found_stop = true;
                }
                0x03 => {
                    // Set palette
                    if ctrl_offset + 2 <= end_offset {
                        color_indices[3] = (data[ctrl_offset] >> 4) & 0x0F;
                        color_indices[2] = data[ctrl_offset] & 0x0F;
                        color_indices[1] = (data[ctrl_offset + 1] >> 4) & 0x0F;
                        color_indices[0] = data[ctrl_offset + 1] & 0x0F;
                        ctrl_offset += 2;
                    }
                }
                0x04 => {
                    // Set alpha
                    if ctrl_offset + 2 <= end_offset {
                        alpha_values[3] = (data[ctrl_offset] >> 4) & 0x0F;
                        alpha_values[2] = data[ctrl_offset] & 0x0F;
                        alpha_values[1] = (data[ctrl_offset + 1] >> 4) & 0x0F;
                        alpha_values[0] = data[ctrl_offset + 1] & 0x0F;
                        ctrl_offset += 2;
                    }
                }
                0x05 => {
                    // Set display area
                    if ctrl_offset + 6 <= end_offset {
                        let x1 = ((data[ctrl_offset] as u16) << 4)
                            | ((data[ctrl_offset + 1] >> 4) as u16);
                        let x2 = (((data[ctrl_offset + 1] & 0x0F) as u16) << 8)
                            | (data[ctrl_offset + 2] as u16);
                        let y1 = ((data[ctrl_offset + 3] as u16) << 4)
                            | ((data[ctrl_offset + 4] >> 4) as u16);
                        let y2 = (((data[ctrl_offset + 4] & 0x0F) as u16) << 8)
                            | (data[ctrl_offset + 5] as u16);
                        x = x1;
                        y = y1;
                        width = x2.saturating_sub(x1) + 1;
                        height = y2.saturating_sub(y1) + 1;
                        ctrl_offset += 6;
                    }
                }
                0x06 => {
                    // Set field offsets
                    if ctrl_offset + 4 <= end_offset {
                        top_field_offset =
                            ((data[ctrl_offset] as usize) << 8) | (data[ctrl_offset + 1] as usize);
                        bottom_field_offset = ((data[ctrl_offset + 2] as usize) << 8)
                            | (data[ctrl_offset + 3] as usize);
                        ctrl_offset += 4;
                    }
                }
                0xFF => break, // End of control sequence
                _ => {}
            }

            if cmd == 0xFF || cmd == 0x02 {
                break;
            }
        }

        // Check if this is the last control block
        // The end of the chain is indicated by next_ctrl_offset pointing to the current block or earlier
        let next_block_abs = packet_start + next_ctrl_offset;
        
        // Break if:
        // 1. next_ctrl_offset points backwards into bitmap data (< dcsq_offset)
        // 2. next_ctrl_offset points to current block or earlier (self-reference = end marker)
        if next_ctrl_offset < dcsq_offset || next_block_abs <= block_start {
            break;
        }

        ctrl_offset = next_block_abs;
    }

    // Calculate field data positions
    let even_start = if top_field_offset > 0 {
        top_field_offset
    } else {
        4
    };
    let odd_start = if bottom_field_offset > 0 {
        bottom_field_offset
    } else {
        even_start
    };

    let even_field_end = odd_start;
    let odd_field_end = packet_start + dcsq_offset;

    let even_field_data = if even_start < even_field_end.min(end_offset) {
        data[even_start..even_field_end.min(end_offset)].to_vec()
    } else {
        Vec::new()
    };

    let odd_field_data = if odd_start < odd_field_end.min(end_offset) {
        data[odd_start..odd_field_end.min(end_offset)].to_vec()
    } else {
        Vec::new()
    };

    Some(SubtitlePacket {
        timestamp_ms: pts,
        duration_ms: if duration > 0 { duration } else { 5000 },
        x,
        y,
        width,
        height,
        color_indices,
        alpha_values,
        even_field_data,
        odd_field_data,
    })
}
