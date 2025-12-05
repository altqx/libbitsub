//! PGS segment types and identifiers.

/// Segment type identifiers as defined in the PGS specification.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentType {
    /// Palette Definition Segment (0x14)
    PaletteDefinition = 0x14,
    /// Object Definition Segment (0x15)
    ObjectDefinition = 0x15,
    /// Presentation Composition Segment (0x16)
    PresentationComposition = 0x16,
    /// Window Definition Segment (0x17)
    WindowDefinition = 0x17,
    /// End Segment (0x80)
    End = 0x80,
}

impl TryFrom<u8> for SegmentType {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x14 => Ok(SegmentType::PaletteDefinition),
            0x15 => Ok(SegmentType::ObjectDefinition),
            0x16 => Ok(SegmentType::PresentationComposition),
            0x17 => Ok(SegmentType::WindowDefinition),
            0x80 => Ok(SegmentType::End),
            _ => Err(value),
        }
    }
}

/// Composition state indicates how the display set should be processed.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositionState {
    /// Normal update - can use previous display set data
    Normal = 0x00,
    /// Acquisition point - new display set boundary
    AcquisitionPoint = 0x40,
    /// Epoch start - complete reset of decoder state
    EpochStart = 0x80,
}

impl TryFrom<u8> for CompositionState {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x00 => Ok(CompositionState::Normal),
            0x40 => Ok(CompositionState::AcquisitionPoint),
            0x80 => Ok(CompositionState::EpochStart),
            _ => Err(value),
        }
    }
}
