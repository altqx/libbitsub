//! Palette Definition Segment parsing.

use crate::utils::{BigEndianReader, ycbcr_to_rgba};

/// Palette Definition Segment contains color palette entries.
#[derive(Debug, Clone)]
pub struct PaletteDefinitionSegment {
    /// Palette ID (0-7)
    pub id: u8,
    /// Version number for this palette
    pub version: u8,
    /// RGBA colors indexed by palette entry ID (up to 256 entries)
    /// Stored as packed u32: [R, G, B, A] in little-endian byte order
    pub rgba: Vec<u32>,
}

impl PaletteDefinitionSegment {
    /// Parse a palette definition segment from binary data.
    pub fn parse(reader: &mut BigEndianReader, length: usize) -> Option<Self> {
        let id = reader.read_u8()?;
        let version = reader.read_u8()?;

        // Each palette entry is 5 bytes: ID, Y, Cr, Cb, A
        let entry_count = (length - 2) / 5;
        
        // Pre-allocate with default transparent (256 possible entries)
        let mut rgba = vec![0u32; 256];

        for _ in 0..entry_count {
            let entry_id = reader.read_u8()? as usize;
            let y = reader.read_u8()?;
            let cr = reader.read_u8()?;
            let cb = reader.read_u8()?;
            let a = reader.read_u8()?;

            // Convert YCbCr to RGBA and store at entry index
            // Note: PGS stores as Y, Cr, Cb but ycbcr_to_rgba expects y, cb, cr
            if entry_id < 256 {
                rgba[entry_id] = ycbcr_to_rgba(y, cb, cr, a);
            }
        }

        Some(Self { id, version, rgba })
    }

    /// Create an empty palette with default transparent values.
    pub fn empty() -> Self {
        Self {
            id: 0,
            version: 0,
            rgba: vec![0u32; 256],
        }
    }
}
