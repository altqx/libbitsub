//! Window Definition Segment parsing.

use crate::utils::BigEndianReader;

/// Window definition specifies the on-screen rectangle for rendering.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowDefinition {
    /// Window ID
    pub id: u8,
    /// Horizontal position (x coordinate)
    pub x: u16,
    /// Vertical position (y coordinate)
    pub y: u16,
    /// Window width
    pub width: u16,
    /// Window height
    pub height: u16,
}

/// Window Definition Segment contains one or more window definitions.
#[derive(Debug, Clone)]
pub struct WindowDefinitionSegment {
    /// List of window definitions
    pub windows: Vec<WindowDefinition>,
}

impl WindowDefinitionSegment {
    /// Parse a window definition segment from binary data.
    pub fn parse(reader: &mut BigEndianReader, _length: usize) -> Option<Self> {
        let count = reader.read_u8()? as usize;
        let mut windows = Vec::with_capacity(count);

        for _ in 0..count {
            let id = reader.read_u8()?;
            let x = reader.read_u16()?;
            let y = reader.read_u16()?;
            let width = reader.read_u16()?;
            let height = reader.read_u16()?;

            windows.push(WindowDefinition {
                id,
                x,
                y,
                width,
                height,
            });
        }

        Some(Self { windows })
    }
}
