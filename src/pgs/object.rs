//! Object Definition Segment parsing.

use crate::utils::BigEndianReader;

/// Object Definition Segment contains RLE-encoded bitmap data.
#[derive(Debug, Clone)]
pub struct ObjectDefinitionSegment {
    /// Object ID (16-bit)
    pub id: u16,
    /// Version number
    pub version: u8,
    /// Sequence flags (bit 7 = first, bit 6 = last)
    pub sequence_flag: u8,
    /// Total data length (only valid for first segment)
    pub data_length: u32,
    /// Object width in pixels (only valid for first segment)
    pub width: u16,
    /// Object height in pixels (only valid for first segment)
    pub height: u16,
    /// RLE-encoded pixel data fragment
    pub data: Vec<u8>,
}

impl ObjectDefinitionSegment {
    /// Parse an object definition segment from binary data.
    pub fn parse(reader: &mut BigEndianReader, length: usize) -> Option<Self> {
        let id = reader.read_u16()?;
        let version = reader.read_u8()?;
        let sequence_flag = reader.read_u8()?;

        let is_first = (sequence_flag & 0x80) != 0;
        
        let (data_length, width, height, data) = if is_first {
            // First segment includes dimensions
            let data_length = reader.read_u24()?;
            let width = reader.read_u16()?;
            let height = reader.read_u16()?;
            let data = reader.read_bytes(length - 11)?;
            (data_length, width, height, data)
        } else {
            // Continuation segment - only raw data
            let data = reader.read_bytes(length - 4)?;
            (0, 0, 0, data)
        };

        Some(Self {
            id,
            version,
            sequence_flag,
            data_length,
            width,
            height,
            data,
        })
    }

    /// Check if this is the first segment in a sequence.
    #[inline]
    pub fn is_first_in_sequence(&self) -> bool {
        (self.sequence_flag & 0x80) != 0
    }

    /// Check if this is the last segment in a sequence.
    #[inline]
    pub fn is_last_in_sequence(&self) -> bool {
        (self.sequence_flag & 0x40) != 0
    }
}

/// Assembled object from one or more ObjectDefinitionSegments.
#[derive(Debug, Clone)]
pub struct AssembledObject {
    /// Object ID
    pub id: u16,
    /// Object version
    pub version: u8,
    /// Width in pixels
    pub width: u16,
    /// Height in pixels
    pub height: u16,
    /// Complete RLE-encoded data
    pub data: Vec<u8>,
}

impl AssembledObject {
    /// Create from a list of object definition segments (must be in order).
    pub fn from_segments(segments: &[ObjectDefinitionSegment]) -> Option<Self> {
        if segments.is_empty() {
            return None;
        }

        let first = &segments[0];
        if !first.is_first_in_sequence() {
            return None;
        }

        let id = first.id;
        let version = first.version;
        let width = first.width;
        let height = first.height;

        // Combine all data segments
        let total_size: usize = segments.iter().map(|s| s.data.len()).sum();
        let mut data = Vec::with_capacity(total_size);
        
        for segment in segments {
            data.extend_from_slice(&segment.data);
        }

        Some(Self {
            id,
            version,
            width,
            height,
            data,
        })
    }
}
