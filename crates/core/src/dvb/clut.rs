//! DVB CLUT defaults, CDS parsing, and YCbCr→RGBA conversion.

use crate::utils::{rgb_to_rgba, ycbcr_to_rgba};

#[derive(Debug, Clone)]
pub struct Clut {
    pub id: u8,
    pub version: i8,
    pub clut4: [u32; 4],
    pub clut16: [u32; 16],
    pub clut256: [u32; 256],
}

impl Clut {
    pub fn default_clut(id: u8) -> Self {
        let mut clut = Self {
            id,
            version: -1,
            clut4: [0; 4],
            clut16: [0; 16],
            clut256: [0; 256],
        };

        clut.clut4[0] = rgb_to_rgba(0, 0, 0, 0);
        clut.clut4[1] = rgb_to_rgba(255, 255, 255, 255);
        clut.clut4[2] = rgb_to_rgba(0, 0, 0, 255);
        clut.clut4[3] = rgb_to_rgba(127, 127, 127, 255);

        clut.clut16[0] = rgb_to_rgba(0, 0, 0, 0);
        for i in 1..16 {
            let (r, g, b) = if i < 8 {
                (
                    if i & 1 != 0 { 255 } else { 0 },
                    if i & 2 != 0 { 255 } else { 0 },
                    if i & 4 != 0 { 255 } else { 0 },
                )
            } else {
                (
                    if i & 1 != 0 { 127 } else { 0 },
                    if i & 2 != 0 { 127 } else { 0 },
                    if i & 4 != 0 { 127 } else { 0 },
                )
            };
            clut.clut16[i] = rgb_to_rgba(r, g, b, 255);
        }

        clut.clut256[0] = rgb_to_rgba(0, 0, 0, 0);
        for i in 1..256usize {
            let (r, g, b, a) = if i < 8 {
                (
                    if i & 1 != 0 { 255 } else { 0 },
                    if i & 2 != 0 { 255 } else { 0 },
                    if i & 4 != 0 { 255 } else { 0 },
                    63,
                )
            } else {
                match i & 0x88 {
                    0x00 => (
                        (if i & 1 != 0 { 85 } else { 0 }) + (if i & 0x10 != 0 { 170 } else { 0 }),
                        (if i & 2 != 0 { 85 } else { 0 }) + (if i & 0x20 != 0 { 170 } else { 0 }),
                        (if i & 4 != 0 { 85 } else { 0 }) + (if i & 0x40 != 0 { 170 } else { 0 }),
                        255,
                    ),
                    0x08 => (
                        (if i & 1 != 0 { 85 } else { 0 }) + (if i & 0x10 != 0 { 170 } else { 0 }),
                        (if i & 2 != 0 { 85 } else { 0 }) + (if i & 0x20 != 0 { 170 } else { 0 }),
                        (if i & 4 != 0 { 85 } else { 0 }) + (if i & 0x40 != 0 { 170 } else { 0 }),
                        127,
                    ),
                    0x80 => (
                        127 + (if i & 1 != 0 { 43 } else { 0 })
                            + (if i & 0x10 != 0 { 85 } else { 0 }),
                        127 + (if i & 2 != 0 { 43 } else { 0 })
                            + (if i & 0x20 != 0 { 85 } else { 0 }),
                        127 + (if i & 4 != 0 { 43 } else { 0 })
                            + (if i & 0x40 != 0 { 85 } else { 0 }),
                        255,
                    ),
                    _ => (
                        (if i & 1 != 0 { 43 } else { 0 }) + (if i & 0x10 != 0 { 85 } else { 0 }),
                        (if i & 2 != 0 { 43 } else { 0 }) + (if i & 0x20 != 0 { 85 } else { 0 }),
                        (if i & 4 != 0 { 43 } else { 0 }) + (if i & 0x40 != 0 { 85 } else { 0 }),
                        255,
                    ),
                }
            };
            clut.clut256[i] = rgb_to_rgba(r as u8, g as u8, b as u8, a as u8);
        }

        clut
    }

    pub fn entries_for_depth(&self, depth: u8) -> &[u32] {
        match depth {
            2 => &self.clut4,
            4 => &self.clut16,
            _ => &self.clut256,
        }
    }

    /// Apply a CLUT definition segment payload.
    pub fn apply_definition(&mut self, data: &[u8]) -> bool {
        if data.len() < 2 {
            return false;
        }

        let clut_id = data[0];
        let version = ((data[1] >> 4) & 0x0F) as i8;
        self.id = clut_id;

        if self.version == version {
            return true;
        }
        self.version = version;

        let mut offset = 2;
        while offset + 2 <= data.len() {
            let entry_id = data[offset] as usize;
            let depth_flags = data[offset + 1] & 0xE0;
            let full_range = (data[offset + 1] & 0x01) != 0;
            offset += 2;

            let (y, cr, cb, t) = if full_range {
                if offset + 4 > data.len() {
                    break;
                }
                let y = data[offset];
                let cr = data[offset + 1];
                let cb = data[offset + 2];
                let t = data[offset + 3];
                offset += 4;
                (y, cr, cb, t)
            } else {
                if offset + 2 > data.len() {
                    break;
                }
                let y = data[offset] & 0xFC;
                let cr = (((data[offset] & 3) << 2) | ((data[offset + 1] >> 6) & 3)) << 4;
                let cb = (data[offset + 1] << 2) & 0xF0;
                let t = (data[offset + 1] << 6) & 0xC0;
                offset += 2;
                (y, cr, cb, t)
            };

            let rgba = ycbcr_t_to_rgba(y, cb, cr, t);

            if depth_flags & 0x80 != 0 && entry_id < 4 {
                self.clut4[entry_id] = rgba;
            }
            if depth_flags & 0x40 != 0 && entry_id < 16 {
                self.clut16[entry_id] = rgba;
            }
            if depth_flags & 0x20 != 0 && entry_id < 256 {
                self.clut256[entry_id] = rgba;
            }
        }

        true
    }
}

/// Convert DVB Y/Cb/Cr/T to packed RGBA.
/// `T` is transparency (0 = opaque, 255 = transparent). `Y == 0` forces full transparency.
#[inline]
pub fn ycbcr_t_to_rgba(y: u8, cb: u8, cr: u8, t: u8) -> u32 {
    if y == 0 {
        return rgb_to_rgba(0, 0, 0, 0);
    }
    let a = 255u8.saturating_sub(t);
    ycbcr_to_rgba(y, cb, cr, a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t_polarity_and_y_zero() {
        let transparent = ycbcr_t_to_rgba(0, 128, 128, 0);
        assert_eq!(transparent.to_le_bytes()[3], 0);

        let opaque_white = ycbcr_t_to_rgba(255, 128, 128, 0);
        let bytes = opaque_white.to_le_bytes();
        assert_eq!(bytes[3], 255);
        assert!(bytes[0] > 250);

        let half = ycbcr_t_to_rgba(128, 128, 128, 128);
        assert_eq!(half.to_le_bytes()[3], 127);
    }

    #[test]
    fn default_clut_basics() {
        let clut = Clut::default_clut(0);
        assert_eq!(clut.clut4[0].to_le_bytes()[3], 0);
        assert_eq!(clut.clut4[1].to_le_bytes()[0], 255);
    }
}
