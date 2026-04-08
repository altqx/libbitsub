//! Object Definition Segment parsing.

use super::MAX_PGS_OBJECT_DATA_LEN;
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
            if length < 11 {
                return None;
            }

            // First segment includes dimensions
            let data_length = reader.read_u24()?;
            if data_length == 0 || (data_length as usize) > MAX_PGS_OBJECT_DATA_LEN {
                return None;
            }
            let width = reader.read_u16()?;
            let height = reader.read_u16()?;
            let data = reader.read_bytes(length - 11)?;
            (data_length, width, height, data)
        } else {
            if length < 4 {
                return None;
            }

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

        if width == 0 || height == 0 {
            return None;
        }

        let declared_size = first.data_length as usize;
        if declared_size == 0 || declared_size > MAX_PGS_OBJECT_DATA_LEN {
            return None;
        }

        // data_length in the ODS includes 4 bytes for width (u16) + height (u16),
        // but those were already parsed above — `data` only contains the RLE payload.
        let payload_size = declared_size.saturating_sub(4);

        // Combine all data segments
        let total_size = segments
            .iter()
            .try_fold(0usize, |acc, segment| acc.checked_add(segment.data.len()))?;
        if total_size == 0 || total_size > payload_size {
            return None;
        }

        let mut data = Vec::with_capacity(total_size);

        for segment in segments {
            data.extend_from_slice(&segment.data);
        }

        if data.len() != payload_size {
            return None;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_first_segment_rejects_short_length() {
        let data = [0x00, 0x01, 0x00, 0x80, 0x00];
        let mut reader = BigEndianReader::new(&data);

        assert!(ObjectDefinitionSegment::parse(&mut reader, 5).is_none());
    }

    #[test]
    fn test_from_segments_rejects_declared_length_mismatch() {
        let segment = ObjectDefinitionSegment {
            id: 1,
            version: 0,
            sequence_flag: 0xC0,
            data_length: 2,
            width: 32,
            height: 32,
            data: vec![1, 2, 3],
        };

        assert!(AssembledObject::from_segments(&[segment]).is_none());
    }
}
