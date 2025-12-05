//! VobSub RLE decoder.
//!
//! DVD subtitles use 2-bit RLE encoding with interlaced fields.

use super::{SubtitlePacket, VobSubPalette};

/// Decode VobSub RLE-encoded bitmap and render to RGBA.
pub fn decode_vobsub_rle(packet: &SubtitlePacket, palette: &VobSubPalette) -> Vec<u8> {
    let width = packet.width as usize;
    let height = packet.height as usize;

    if width == 0 || height == 0 {
        return Vec::new();
    }

    // Allocate RGBA buffer
    let mut rgba = vec![0u8; width * height * 4];

    // Build 4-color lookup table with alpha
    let mut colors = [[0u8; 4]; 4];
    for i in 0..4 {
        let palette_color = palette.rgba[packet.color_indices[i] as usize];
        let alpha = ((packet.alpha_values[i] as u32 * 255) / 15) as u8;

        // Extract RGBA from packed u32 (little-endian: R, G, B, A)
        let bytes = palette_color.to_le_bytes();
        colors[i] = [bytes[0], bytes[1], bytes[2], alpha];
    }

    // Decode even field (lines 0, 2, 4, ...)
    decode_field(
        &packet.even_field_data,
        &mut rgba,
        width,
        height,
        0,
        &colors,
    );

    // Decode odd field (lines 1, 3, 5, ...)
    decode_field(&packet.odd_field_data, &mut rgba, width, height, 1, &colors);

    rgba
}

/// Decode a single field (even or odd lines).
fn decode_field(
    field_data: &[u8],
    rgba: &mut [u8],
    width: usize,
    height: usize,
    start_line: usize,
    colors: &[[u8; 4]; 4],
) {
    let mut byte_pos = 0;
    let mut nibble_pos = 0; // 0 = high nibble, 1 = low nibble

    let mut y = start_line;
    while y < height {
        let mut x = 0;

        // Each line must start on a byte boundary
        if nibble_pos != 0 {
            byte_pos += 1;
            nibble_pos = 0;
        }

        // Safety check
        if byte_pos >= field_data.len() {
            // Fill remaining lines with transparent
            while x < width {
                let pixel_offset = (y * width + x) * 4;
                if pixel_offset + 4 <= rgba.len() {
                    rgba[pixel_offset..pixel_offset + 4].copy_from_slice(&colors[0]);
                }
                x += 1;
            }
            y += 2;
            continue;
        }

        while x < width && byte_pos < field_data.len() {
            let prev_byte_pos = byte_pos;
            let prev_nibble_pos = nibble_pos;

            let (color_idx, run_length, new_byte_pos, new_nibble_pos) =
                read_rle_code(field_data, byte_pos, nibble_pos);

            byte_pos = new_byte_pos;
            nibble_pos = new_nibble_pos;

            // Safety: ensure we're making progress
            if byte_pos == prev_byte_pos && nibble_pos == prev_nibble_pos {
                byte_pos += 1;
                nibble_pos = 0;
                while x < width {
                    let pixel_offset = (y * width + x) * 4;
                    if pixel_offset + 4 <= rgba.len() {
                        rgba[pixel_offset..pixel_offset + 4].copy_from_slice(&colors[0]);
                    }
                    x += 1;
                }
                break;
            }

            // End of line (run_length == 0)
            if run_length == 0 {
                while x < width {
                    let pixel_offset = (y * width + x) * 4;
                    if pixel_offset + 4 <= rgba.len() {
                        rgba[pixel_offset..pixel_offset + 4].copy_from_slice(&colors[0]);
                    }
                    x += 1;
                }
                break;
            }

            // Fill pixels
            let end_x = (x + run_length).min(width);
            let color = &colors[color_idx];
            while x < end_x {
                let pixel_offset = (y * width + x) * 4;
                if pixel_offset + 4 <= rgba.len() {
                    rgba[pixel_offset..pixel_offset + 4].copy_from_slice(color);
                }
                x += 1;
            }
        }

        // Fill any remaining pixels
        while x < width {
            let pixel_offset = (y * width + x) * 4;
            if pixel_offset + 4 <= rgba.len() {
                rgba[pixel_offset..pixel_offset + 4].copy_from_slice(&colors[0]);
            }
            x += 1;
        }

        y += 2;
    }
}

/// Read a VobSub RLE code using nibble-based positioning.
///
/// Returns (color_index, run_length, new_byte_pos, new_nibble_pos).
fn read_rle_code(
    data: &[u8],
    mut byte_pos: usize,
    mut nibble_pos: usize,
) -> (usize, usize, usize, usize) {
    // Helper to read a nibble and advance position
    let read_nibble = |data: &[u8], bp: &mut usize, np: &mut usize| -> u8 {
        let nibble = if *bp >= data.len() {
            0
        } else {
            let byte = data[*bp];
            if *np == 0 {
                (byte >> 4) & 0x0F
            } else {
                byte & 0x0F
            }
        };

        // Advance
        if *np == 0 {
            *np = 1;
        } else {
            *np = 0;
            *bp += 1;
        }

        nibble
    };

    // Read first nibble
    let n0 = read_nibble(data, &mut byte_pos, &mut nibble_pos) as usize;

    // 4-bit code: nibble >= 4 means length bits are non-zero
    if n0 >= 0x04 {
        let run_length = n0 >> 2;
        let color_idx = n0 & 0x03;
        return (color_idx, run_length, byte_pos, nibble_pos);
    }

    // Read second nibble for 8-bit value
    let n1 = read_nibble(data, &mut byte_pos, &mut nibble_pos) as usize;
    let val8 = (n0 << 4) | n1;

    // 8-bit code: value >= 0x10 means length >= 4
    if val8 >= 0x10 {
        let run_length = val8 >> 2;
        let color_idx = val8 & 0x03;
        return (color_idx, run_length, byte_pos, nibble_pos);
    }

    // Read third nibble for 12-bit value
    let n2 = read_nibble(data, &mut byte_pos, &mut nibble_pos) as usize;
    let val12 = (val8 << 4) | n2;

    // 12-bit code: value >= 0x040 means length >= 16
    if val12 >= 0x040 {
        let run_length = val12 >> 2;
        let color_idx = val12 & 0x03;
        return (color_idx, run_length, byte_pos, nibble_pos);
    }

    // Read fourth nibble for 16-bit value
    let n3 = read_nibble(data, &mut byte_pos, &mut nibble_pos) as usize;
    let val16 = (val12 << 4) | n3;

    // 16-bit code: run = value >> 2, color = value & 3
    let run_length = val16 >> 2;
    let color_idx = val16 & 0x03;

    (color_idx, run_length, byte_pos, nibble_pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rle_code_4bit() {
        // Nibble 0x04 = run 1, color 0
        // Nibble 0x05 = run 1, color 1
        // etc.
        let data = [0x45]; // Two nibbles: 0x4, 0x5
        let (color, run, bp, np) = read_rle_code(&data, 0, 0);
        assert_eq!(run, 1);
        assert_eq!(color, 0);
        assert_eq!(bp, 0);
        assert_eq!(np, 1);
    }
}
