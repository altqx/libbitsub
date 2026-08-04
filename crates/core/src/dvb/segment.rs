//! DVB subtitle segment headers and types.

pub const SYNC_BYTE: u8 = 0x0F;
pub const PAGE_COMPOSITION: u8 = 0x10;
pub const REGION_COMPOSITION: u8 = 0x11;
pub const CLUT_DEFINITION: u8 = 0x12;
pub const OBJECT_DATA: u8 = 0x13;
pub const DISPLAY_DEFINITION: u8 = 0x14;
pub const END_OF_DISPLAY_SET: u8 = 0x80;
pub const STUFFING: u8 = 0xFF;

pub const PAGE_STATE_NORMAL: u8 = 0;
pub const PAGE_STATE_ACQUISITION: u8 = 1;
pub const PAGE_STATE_MODE_CHANGE: u8 = 2;

#[derive(Debug, Clone)]
pub struct Segment<'a> {
    pub segment_type: u8,
    pub page_id: u16,
    pub data: &'a [u8],
}

impl<'a> Segment<'a> {
    /// Parse one segment starting at `data[0]`. Returns `(segment, bytes_consumed)`.
    pub fn parse(data: &'a [u8]) -> Option<(Self, usize)> {
        if data.len() < 6 || data[0] != SYNC_BYTE {
            return None;
        }

        let segment_type = data[1];
        let page_id = u16::from_be_bytes([data[2], data[3]]);
        let length = u16::from_be_bytes([data[4], data[5]]) as usize;
        let total = 6 + length;
        if data.len() < total {
            return None;
        }

        Some((
            Self {
                segment_type,
                page_id,
                data: &data[6..total],
            },
            total,
        ))
    }

    pub fn is_known_type(segment_type: u8) -> bool {
        matches!(
            segment_type,
            PAGE_COMPOSITION
                | REGION_COMPOSITION
                | CLUT_DEFINITION
                | OBJECT_DATA
                | DISPLAY_DEFINITION
                | END_OF_DISPLAY_SET
                | STUFFING
        )
    }
}

#[derive(Debug, Clone)]
pub struct PageRegionRef {
    pub region_id: u8,
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Clone)]
pub struct PageComposition {
    pub timeout_seconds: u8,
    pub version: u8,
    pub state: u8,
    pub regions: Vec<PageRegionRef>,
}

impl PageComposition {
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < 2 {
            return None;
        }

        let timeout_seconds = data[0];
        let version = (data[1] >> 4) & 0x0F;
        let state = (data[1] >> 2) & 0x03;
        let mut offset = 2;
        let mut regions = Vec::new();

        while offset + 6 <= data.len() {
            let region_id = data[offset];
            let x = u16::from_be_bytes([data[offset + 2], data[offset + 3]]);
            let y = u16::from_be_bytes([data[offset + 4], data[offset + 5]]);
            regions.push(PageRegionRef { region_id, x, y });
            offset += 6;
        }

        Some(Self {
            timeout_seconds,
            version,
            state,
            regions,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RegionObjectRef {
    pub object_id: u16,
    pub object_type: u8,
    pub provider_flag: u8,
    pub x: u16,
    pub y: u16,
    pub foreground: u8,
    pub background: u8,
}

#[derive(Debug, Clone)]
pub struct RegionComposition {
    pub region_id: u8,
    pub version: u8,
    pub fill_flag: bool,
    pub width: u16,
    pub height: u16,
    pub depth: u8,
    pub clut_id: u8,
    pub region_level_8: u8,
    pub region_level_4: u8,
    pub region_level_2: u8,
    pub objects: Vec<RegionObjectRef>,
}

impl RegionComposition {
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < 10 {
            return None;
        }

        let region_id = data[0];
        let version = (data[1] >> 4) & 0x0F;
        let fill_flag = (data[1] & 0x08) != 0;
        let width = u16::from_be_bytes([data[2], data[3]]);
        let height = u16::from_be_bytes([data[4], data[5]]);
        let depth = (data[6] >> 2) & 0x07;
        let clut_id = data[7];
        let region_level_8 = data[8];
        let region_level_4 = data[9] >> 4;
        let region_level_2 = (data[9] >> 2) & 0x03;

        let mut offset = 10;
        let mut objects = Vec::new();

        while offset + 6 <= data.len() {
            let object_id = u16::from_be_bytes([data[offset], data[offset + 1]]);
            let object_type = (data[offset + 2] >> 6) & 0x03;
            let provider_flag = (data[offset + 2] >> 4) & 0x03;
            let x = (((data[offset + 2] as u16) & 0x0F) << 8) | data[offset + 3] as u16;
            let y = (((data[offset + 4] as u16) & 0x0F) << 8) | data[offset + 5] as u16;
            offset += 6;

            let mut foreground = 0u8;
            let mut background = 0u8;
            if object_type == 1 || object_type == 2 {
                if offset + 2 > data.len() {
                    break;
                }
                foreground = data[offset];
                background = data[offset + 1];
                offset += 2;
            }

            objects.push(RegionObjectRef {
                object_id,
                object_type,
                provider_flag,
                x,
                y,
                foreground,
                background,
            });
        }

        Some(Self {
            region_id,
            version,
            fill_flag,
            width,
            height,
            depth,
            clut_id,
            region_level_8,
            region_level_4,
            region_level_2,
            objects,
        })
    }

    pub fn bgcolor(&self) -> u8 {
        match self.depth {
            2 => self.region_level_2,
            4 => self.region_level_4,
            _ => self.region_level_8,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DisplayDefinition {
    pub version: u8,
    pub width: u16,
    pub height: u16,
    pub window_x: u16,
    pub window_y: u16,
}

impl DisplayDefinition {
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < 5 {
            return None;
        }

        let version = (data[0] >> 4) & 0x0F;
        let window_flag = (data[0] & 0x08) != 0;
        let width = u16::from_be_bytes([data[1], data[2]]).saturating_add(1);
        let height = u16::from_be_bytes([data[3], data[4]]).saturating_add(1);

        let (window_x, window_y) = if window_flag && data.len() >= 13 {
            (
                u16::from_be_bytes([data[5], data[6]]),
                u16::from_be_bytes([data[9], data[10]]),
            )
        } else {
            (0, 0)
        };

        Some(Self {
            version,
            width,
            height,
            window_x,
            window_y,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_page_composition() {
        let data = [
            0x05, // timeout 5s
            0x18, // version 1, state mode-change (2)
            0x01, 0x00, 0x00, 0x10, 0x00, 0x20, // region 1 at (16, 32)
        ];
        let page = PageComposition::parse(&data).unwrap();
        assert_eq!(page.timeout_seconds, 5);
        assert_eq!(page.version, 1);
        assert_eq!(page.state, PAGE_STATE_MODE_CHANGE);
        assert_eq!(page.regions.len(), 1);
        assert_eq!(page.regions[0].region_id, 1);
        assert_eq!(page.regions[0].x, 16);
        assert_eq!(page.regions[0].y, 32);
    }
}
