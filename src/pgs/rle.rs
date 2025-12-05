//! Run-length encoding decoder for PGS subtitle bitmaps.
//!
//! PGS uses a variant of RLE encoding where:
//! - Non-zero bytes are literal palette indices
//! - Zero byte starts a control sequence:
//!   - 0x00 0x00 = end of line
//!   - 0x00 0xNN = repeat color 0, NN times (NN in 1-63)
//!   - 0x00 0x4N 0xNN = repeat color 0, N*256+NN times
//!   - 0x00 0x8N 0xCC = repeat color CC, N times (N in 1-63)
//!   - 0x00 0xCN 0xNN 0xCC = repeat color CC, N*256+NN times

/// Decode RLE-encoded data to indexed pixel values (palette indices).
/// This is optimized for high-frequency subtitle animations where we want to
/// decode once and apply different palettes quickly.
///
/// Returns the number of decoded pixels.
#[inline]
pub fn decode_rle_to_indexed(data: &[u8], target: &mut [u8]) -> usize {
    let mut idx = 0;
    let mut pos = 0;
    let len = data.len();
    let target_len = target.len();

    while pos < len && idx < target_len {
        let byte1 = data[pos];
        pos += 1;

        // Most common case: literal palette index
        if byte1 != 0 {
            target[idx] = byte1;
            idx += 1;
            continue;
        }

        // Zero byte - start of control sequence
        if pos >= len {
            break;
        }

        let byte2 = data[pos];
        pos += 1;

        // End of line marker
        if byte2 == 0 {
            continue;
        }

        // Parse run-length encoding
        let (count, value) = if byte2 & 0xC0 == 0xC0 {
            // Extended length with color: 0x00 0xCN 0xNN 0xCC
            let high = (byte2 & 0x3F) as usize;
            let low = data.get(pos).copied().unwrap_or(0) as usize;
            pos += 1;
            let color = data.get(pos).copied().unwrap_or(0);
            pos += 1;
            ((high << 8) | low, color)
        } else if byte2 & 0x80 != 0 {
            // Short length with color: 0x00 0x8N 0xCC
            let count = (byte2 & 0x3F) as usize;
            let color = data.get(pos).copied().unwrap_or(0);
            pos += 1;
            (count, color)
        } else if byte2 & 0x40 != 0 {
            // Extended length, transparent: 0x00 0x4N 0xNN
            let high = (byte2 & 0x3F) as usize;
            let low = data.get(pos).copied().unwrap_or(0) as usize;
            pos += 1;
            ((high << 8) | low, 0)
        } else {
            // Short length, transparent: 0x00 0xNN
            ((byte2 & 0x3F) as usize, 0)
        };

        // Fill with the value
        let end = (idx + count).min(target_len);
        if count > 8 {
            target[idx..end].fill(value);
        } else {
            // Unrolled loop for small runs
            while idx < end {
                target[idx] = value;
                idx += 1;
            }
        }
        idx = end;
    }

    idx
}

/// Decode RLE-encoded data directly to RGBA pixels using a palette lookup.
/// This is the fast path when palette doesn't change between frames.
///
/// Returns the number of decoded pixels.
#[inline]
pub fn decode_rle_to_rgba(data: &[u8], palette: &[u32], target: &mut [u32]) -> usize {
    let mut idx = 0;
    let mut pos = 0;
    let len = data.len();
    let target_len = target.len();
    let palette_len = palette.len();

    // Cache transparent color
    let transparent = if palette_len > 0 { palette[0] } else { 0 };

    while pos < len && idx < target_len {
        let byte1 = data[pos];
        pos += 1;

        // Most common case: literal palette index
        if byte1 != 0 {
            let color = if (byte1 as usize) < palette_len {
                palette[byte1 as usize]
            } else {
                0
            };
            target[idx] = color;
            idx += 1;
            continue;
        }

        // Zero byte - start of control sequence
        if pos >= len {
            break;
        }

        let byte2 = data[pos];
        pos += 1;

        // End of line marker
        if byte2 == 0 {
            continue;
        }

        // Parse run-length encoding
        let (count, color) = if byte2 & 0xC0 == 0xC0 {
            // Extended length with color: 0x00 0xCN 0xNN 0xCC
            let high = (byte2 & 0x3F) as usize;
            let low = data.get(pos).copied().unwrap_or(0) as usize;
            pos += 1;
            let color_idx = data.get(pos).copied().unwrap_or(0) as usize;
            pos += 1;
            let color = if color_idx < palette_len {
                palette[color_idx]
            } else {
                0
            };
            ((high << 8) | low, color)
        } else if byte2 & 0x80 != 0 {
            // Short length with color: 0x00 0x8N 0xCC
            let count = (byte2 & 0x3F) as usize;
            let color_idx = data.get(pos).copied().unwrap_or(0) as usize;
            pos += 1;
            let color = if color_idx < palette_len {
                palette[color_idx]
            } else {
                0
            };
            (count, color)
        } else if byte2 & 0x40 != 0 {
            // Extended length, transparent: 0x00 0x4N 0xNN
            let high = (byte2 & 0x3F) as usize;
            let low = data.get(pos).copied().unwrap_or(0) as usize;
            pos += 1;
            ((high << 8) | low, transparent)
        } else {
            // Short length, transparent: 0x00 0xNN
            ((byte2 & 0x3F) as usize, transparent)
        };

        // Fill with the color
        let end = (idx + count).min(target_len);
        if count > 8 {
            target[idx..end].fill(color);
        } else {
            while idx < end {
                target[idx] = color;
                idx += 1;
            }
        }
        idx = end;
    }

    idx
}

/// Apply a palette to indexed pixel data, producing RGBA output.
/// This is used when we've cached the indexed pixels and need to apply a new palette.
#[inline]
pub fn apply_palette(indexed: &[u8], palette: &[u32], target: &mut [u32]) {
    let len = indexed.len().min(target.len());
    let palette_len = palette.len();

    // Process in chunks for better cache utilization
    for i in 0..len {
        let idx = indexed[i] as usize;
        target[i] = if idx < palette_len { palette[idx] } else { 0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_literal() {
        // Simple literal values
        let data = [1, 2, 3, 4, 5];
        let mut target = vec![0u8; 10];
        let count = decode_rle_to_indexed(&data, &mut target);
        assert_eq!(count, 5);
        assert_eq!(&target[..5], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn test_decode_short_run_transparent() {
        // 0x00 0x05 = 5 transparent pixels
        let data = [0x00, 0x05];
        let mut target = vec![0xFFu8; 10];
        let count = decode_rle_to_indexed(&data, &mut target);
        assert_eq!(count, 5);
        assert_eq!(&target[..5], &[0, 0, 0, 0, 0]);
    }

    #[test]
    fn test_decode_short_run_color() {
        // 0x00 0x85 0x07 = 5 pixels of color 7
        let data = [0x00, 0x85, 0x07];
        let mut target = vec![0u8; 10];
        let count = decode_rle_to_indexed(&data, &mut target);
        assert_eq!(count, 5);
        assert_eq!(&target[..5], &[7, 7, 7, 7, 7]);
    }

    #[test]
    fn test_decode_end_of_line() {
        // 1, EOL, 2
        let data = [0x01, 0x00, 0x00, 0x02];
        let mut target = vec![0u8; 10];
        let count = decode_rle_to_indexed(&data, &mut target);
        assert_eq!(count, 2);
        assert_eq!(&target[..2], &[1, 2]);
    }
}
