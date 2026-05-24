//! Presentation Composition Segment parsing.

use super::segment::CompositionState;
use crate::utils::BigEndianReader;

/// Composition object reference within a presentation.
#[derive(Debug, Clone, Copy, Default)]
pub struct CompositionObject {
    /// Object ID reference
    pub object_id: u16,
    /// Window ID reference
    pub window_id: u8,
    /// Cropping flag (bit 7 = has cropping)
    pub cropped_flag: u8,
    /// Horizontal position within window
    pub x: u16,
    /// Vertical position within window
    pub y: u16,
    /// Cropping horizontal position (if cropped_flag set)
    pub crop_x: u16,
    /// Cropping vertical position (if cropped_flag set)
    pub crop_y: u16,
    /// Cropping width (if cropped_flag set)
    pub crop_width: u16,
    /// Cropping height (if cropped_flag set)
    pub crop_height: u16,
}

impl CompositionObject {
    /// Check if this object has cropping enabled.
    #[inline]
    pub fn has_cropping(&self) -> bool {
        (self.cropped_flag & 0x80) != 0
    }
}

/// Presentation Composition Segment contains display parameters.
#[derive(Debug, Clone)]
pub struct PresentationCompositionSegment {
    /// Video width
    pub width: u16,
    /// Video height
    pub height: u16,
    /// Frame rate (encoded value)
    pub frame_rate: u8,
    /// Composition number (sequence identifier)
    pub composition_number: u16,
    /// Composition state (Normal, AcquisitionPoint, EpochStart)
    pub composition_state: u8,
    /// Palette update flag (bit 7 = palette only update)
    pub palette_update_flag: u8,
    /// Palette ID to use
    pub palette_id: u8,
    /// List of composition objects to render
    pub composition_objects: Vec<CompositionObject>,
}

impl PresentationCompositionSegment {
    /// Parse a presentation composition segment from binary data.
    pub fn parse(reader: &mut BigEndianReader, _length: usize) -> Option<Self> {
        let width = reader.read_u16()?;
        let height = reader.read_u16()?;
        let frame_rate = reader.read_u8()?;
        let composition_number = reader.read_u16()?;
        let composition_state = reader.read_u8()?;
        let palette_update_flag = reader.read_u8()?;
        let palette_id = reader.read_u8()?;

        let count = reader.read_u8()? as usize;
        let mut composition_objects = Vec::with_capacity(count);

        for _ in 0..count {
            let object_id = reader.read_u16()?;
            let window_id = reader.read_u8()?;
            let cropped_flag = reader.read_u8()?;
            let x = reader.read_u16()?;
            let y = reader.read_u16()?;

            let (crop_x, crop_y, crop_width, crop_height) = if (cropped_flag & 0x80) != 0 {
                (
                    reader.read_u16()?,
                    reader.read_u16()?,
                    reader.read_u16()?,
                    reader.read_u16()?,
                )
            } else {
                (0, 0, 0, 0)
            };

            composition_objects.push(CompositionObject {
                object_id,
                window_id,
                cropped_flag,
                x,
                y,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
            });
        }

        Some(Self {
            width,
            height,
            frame_rate,
            composition_number,
            composition_state,
            palette_update_flag,
            palette_id,
            composition_objects,
        })
    }

    /// Get the composition state enum.
    pub fn get_composition_state(&self) -> Option<CompositionState> {
        CompositionState::try_from(self.composition_state).ok()
    }

    /// Check if this is an epoch start (complete reset).
    #[inline]
    pub fn is_epoch_start(&self) -> bool {
        self.composition_state == CompositionState::EpochStart as u8
    }

    /// Check if this is an acquisition point (new boundary).
    #[inline]
    pub fn is_acquisition_point(&self) -> bool {
        self.composition_state == CompositionState::AcquisitionPoint as u8
    }

    /// Check if this is a palette-only update.
    #[inline]
    pub fn is_palette_update_only(&self) -> bool {
        (self.palette_update_flag & 0x80) != 0
    }
}
