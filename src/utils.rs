//! Utility functions for binary reading and color conversion.

use std::io::{Read, Cursor};
use byteorder::{BigEndian, ReadBytesExt};

/// Binary reader wrapper for big-endian data (used in PGS).
pub struct BigEndianReader<'a> {
    cursor: Cursor<&'a [u8]>,
}

impl<'a> BigEndianReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            cursor: Cursor::new(data),
        }
    }

    #[inline]
    pub fn position(&self) -> usize {
        self.cursor.position() as usize
    }

    #[inline]
    pub fn set_position(&mut self, pos: usize) {
        self.cursor.set_position(pos as u64);
    }

    #[inline]
    pub fn remaining(&self) -> usize {
        self.cursor.get_ref().len() - self.position()
    }

    #[inline]
    pub fn read_u8(&mut self) -> Option<u8> {
        self.cursor.read_u8().ok()
    }

    #[inline]
    pub fn read_u16(&mut self) -> Option<u16> {
        self.cursor.read_u16::<BigEndian>().ok()
    }

    #[inline]
    pub fn read_u24(&mut self) -> Option<u32> {
        let mut buf = [0u8; 3];
        self.cursor.read_exact(&mut buf).ok()?;
        Some(((buf[0] as u32) << 16) | ((buf[1] as u32) << 8) | (buf[2] as u32))
    }

    #[inline]
    pub fn read_u32(&mut self) -> Option<u32> {
        self.cursor.read_u32::<BigEndian>().ok()
    }

    #[inline]
    pub fn read_bytes(&mut self, len: usize) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; len];
        self.cursor.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    #[inline]
    pub fn skip(&mut self, len: usize) -> bool {
        let new_pos = self.position() + len;
        if new_pos <= self.cursor.get_ref().len() {
            self.cursor.set_position(new_pos as u64);
            true
        } else {
            false
        }
    }
}

/// Convert YCbCr to RGBA (packed as u32 in little-endian: ABGR layout for canvas).
/// This matches the JavaScript implementation exactly.
#[inline]
pub fn ycbcr_to_rgba(y: u8, cb: u8, cr: u8, a: u8) -> u32 {
    let y = y as f32;
    let cb = (cb as f32) - 128.0;
    let cr = (cr as f32) - 128.0;

    let r = clamp((y + 1.40200 * cr).round() as i32, 0, 255) as u8;
    let g = clamp((y - 0.34414 * cb - 0.71414 * cr).round() as i32, 0, 255) as u8;
    let b = clamp((y + 1.77200 * cb).round() as i32, 0, 255) as u8;

    // Pack as RGBA (for ImageData which expects [R, G, B, A] bytes)
    // In little-endian memory: byte order is R, G, B, A
    u32::from_le_bytes([r, g, b, a])
}

/// Convert RGB to packed RGBA u32.
#[inline]
pub fn rgb_to_rgba(r: u8, g: u8, b: u8, a: u8) -> u32 {
    u32::from_le_bytes([r, g, b, a])
}

#[inline]
pub fn clamp<T: Ord>(value: T, min: T, max: T) -> T {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// Fast binary search for finding timestamp index.
pub fn binary_search_timestamp(timestamps: &[u32], target: u32) -> usize {
    if timestamps.is_empty() {
        return 0;
    }

    let mut low = 0;
    let mut high = timestamps.len();

    while low < high {
        let mid = low + (high - low) / 2;
        if timestamps[mid] <= target {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    if low > 0 { low - 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_binary_search_timestamp() {
        let timestamps = vec![0, 1000, 2000, 3000, 4000];
        
        assert_eq!(binary_search_timestamp(&timestamps, 0), 0);
        assert_eq!(binary_search_timestamp(&timestamps, 500), 0);
        assert_eq!(binary_search_timestamp(&timestamps, 1000), 1);
        assert_eq!(binary_search_timestamp(&timestamps, 1500), 1);
        assert_eq!(binary_search_timestamp(&timestamps, 4500), 4);
    }

    #[test]
    fn test_ycbcr_to_rgba() {
        // White (Y=255, Cb=128, Cr=128) -> RGB(255, 255, 255)
        let white = ycbcr_to_rgba(255, 128, 128, 255);
        let bytes = white.to_le_bytes();
        assert_eq!(bytes[0], 255); // R
        assert_eq!(bytes[1], 255); // G
        assert_eq!(bytes[2], 255); // B
        assert_eq!(bytes[3], 255); // A
    }
}
