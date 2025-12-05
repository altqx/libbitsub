//! Display Set parsing and representation.

use super::{
    PaletteDefinitionSegment,
    ObjectDefinitionSegment,
    WindowDefinitionSegment,
    WindowDefinition,
    PresentationCompositionSegment,
    SegmentType,
};
use crate::utils::BigEndianReader;

/// A display set contains all segments for a single subtitle update.
#[derive(Debug, Clone)]
pub struct DisplaySet {
    /// Presentation timestamp in 90kHz units
    pub pts: u32,
    /// Decoding timestamp in 90kHz units
    pub dts: u32,
    /// Presentation composition segment (defines what to render)
    pub composition: Option<PresentationCompositionSegment>,
    /// Palette definitions in this display set
    pub palettes: Vec<PaletteDefinitionSegment>,
    /// Object definitions in this display set
    pub objects: Vec<ObjectDefinitionSegment>,
    /// Window definitions in this display set
    pub windows: Vec<WindowDefinitionSegment>,
}

impl DisplaySet {
    /// Create a new empty display set.
    pub fn new() -> Self {
        Self {
            pts: 0,
            dts: 0,
            composition: None,
            palettes: Vec::new(),
            objects: Vec::new(),
            windows: Vec::new(),
        }
    }

    /// Parse a display set from binary data.
    /// Returns the display set and the number of bytes consumed.
    pub fn parse(data: &[u8], include_header: bool) -> Option<(Self, usize)> {
        let mut reader = BigEndianReader::new(data);
        let mut display_set = Self::new();

        loop {
            let pts: u32;
            let dts: u32;

            if include_header {
                // Read PGS header
                let magic = reader.read_u16()?;
                if magic != 0x5047 {
                    return None; // Invalid magic number "PG"
                }

                pts = reader.read_u32()?;
                dts = reader.read_u32()?;

                if display_set.pts == 0 {
                    display_set.pts = pts;
                    display_set.dts = dts;
                }
            } else {
                pts = 0;
                dts = 0;
            }

            let segment_type = reader.read_u8()?;
            let segment_size = reader.read_u16()? as usize;

            // Check if we have enough data
            if reader.remaining() < segment_size {
                return None;
            }

            let start_pos = reader.position();

            match SegmentType::try_from(segment_type) {
                Ok(SegmentType::PaletteDefinition) => {
                    if let Some(palette) = PaletteDefinitionSegment::parse(&mut reader, segment_size) {
                        display_set.palettes.push(palette);
                    }
                }
                Ok(SegmentType::ObjectDefinition) => {
                    if let Some(object) = ObjectDefinitionSegment::parse(&mut reader, segment_size) {
                        display_set.objects.push(object);
                    }
                }
                Ok(SegmentType::PresentationComposition) => {
                    if let Some(composition) = PresentationCompositionSegment::parse(&mut reader, segment_size) {
                        display_set.pts = pts;
                        display_set.dts = dts;
                        display_set.composition = Some(composition);
                    }
                }
                Ok(SegmentType::WindowDefinition) => {
                    if let Some(window) = WindowDefinitionSegment::parse(&mut reader, segment_size) {
                        display_set.windows.push(window);
                    }
                }
                Ok(SegmentType::End) => {
                    // End of display set
                    break;
                }
                Err(_) => {
                    // Unknown segment type - skip
                    reader.skip(segment_size);
                }
            }

            // Ensure we consumed the expected amount
            let consumed = reader.position() - start_pos;
            if consumed < segment_size {
                reader.skip(segment_size - consumed);
            }
        }

        Some((display_set, reader.position()))
    }

    /// Get the presentation timestamp in milliseconds.
    #[inline]
    pub fn pts_ms(&self) -> u32 {
        self.pts / 90
    }

    /// Find a window definition by ID.
    pub fn find_window(&self, id: u8) -> Option<&WindowDefinition> {
        for wds in &self.windows {
            for window in &wds.windows {
                if window.id == id {
                    return Some(window);
                }
            }
        }
        None
    }

    /// Find a palette by ID.
    pub fn find_palette(&self, id: u8) -> Option<&PaletteDefinitionSegment> {
        self.palettes.iter().find(|p| p.id == id)
    }
}

impl Default for DisplaySet {
    fn default() -> Self {
        Self::new()
    }
}
