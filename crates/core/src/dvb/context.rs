//! Stateful DVB composition buffer (regions, CLUTs, objects, page).

use std::collections::HashMap;

use super::clut::Clut;
use super::pes::iter_segments;
use super::rle::{ObjectField, decode_object_field};
use super::segment::{
    CLUT_DEFINITION, DISPLAY_DEFINITION, DisplayDefinition, END_OF_DISPLAY_SET, OBJECT_DATA,
    PAGE_COMPOSITION, PAGE_STATE_ACQUISITION, PAGE_STATE_MODE_CHANGE, PageComposition,
    REGION_COMPOSITION, RegionComposition,
};
use super::{DEFAULT_SCREEN_HEIGHT, DEFAULT_SCREEN_WIDTH, MAX_DVB_BITMAP_PIXELS};

#[derive(Debug, Clone)]
struct Region {
    version: i8,
    width: u16,
    height: u16,
    depth: u8,
    clut_id: u8,
    bgcolor: u8,
    pixels: Vec<u8>,
    objects: Vec<(u16, u16, u16)>, // object_id, x, y
}

#[derive(Debug, Clone)]
struct ObjectPlacement {
    region_id: u8,
    x: u16,
    y: u16,
}

#[derive(Debug, Clone)]
pub struct DvbComposition {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct DvbFrame {
    pub width: u16,
    pub height: u16,
    pub compositions: Vec<DvbComposition>,
}

#[derive(Debug, Clone)]
pub struct DisplayCue {
    pub pts_ms: u32,
    pub timeout_ms: u32,
    pub page_state: u8,
    pub region_count: u32,
    pub screen_width: u16,
    pub screen_height: u16,
    /// Snapshot of composed frame at this cue (None = clear screen).
    pub frame: Option<DvbFrame>,
}

pub struct DvbContext {
    regions: HashMap<u8, Region>,
    cluts: HashMap<u8, Clut>,
    object_placements: HashMap<u16, Vec<ObjectPlacement>>,
    page: Option<PageComposition>,
    display_definition: Option<DisplayDefinition>,
}

impl DvbContext {
    pub fn new() -> Self {
        Self {
            regions: HashMap::new(),
            cluts: HashMap::new(),
            object_placements: HashMap::new(),
            page: None,
            display_definition: None,
        }
    }

    pub fn reset(&mut self) {
        self.regions.clear();
        self.cluts.clear();
        self.object_placements.clear();
        self.page = None;
        self.display_definition = None;
    }

    pub fn screen_size(&self) -> (u16, u16) {
        self.display_definition
            .as_ref()
            .map(|dds| (dds.width, dds.height))
            .unwrap_or((DEFAULT_SCREEN_WIDTH, DEFAULT_SCREEN_HEIGHT))
    }

    /// Apply one timed ES/PES payload and snapshot only a complete display set.
    pub fn apply_payload(&mut self, pts_ms: u32, payload: &[u8]) -> Option<DisplayCue> {
        let segments = iter_segments(payload);
        let mut saw_eds = false;

        for segment in segments {
            match segment.segment_type {
                PAGE_COMPOSITION => {
                    if let Some(page) = PageComposition::parse(segment.data) {
                        if matches!(page.state, PAGE_STATE_ACQUISITION | PAGE_STATE_MODE_CHANGE) {
                            self.regions.clear();
                            self.cluts.clear();
                            self.object_placements.clear();
                        }
                        self.page = Some(page);
                    }
                }
                REGION_COMPOSITION => {
                    if let Some(rcs) = RegionComposition::parse(segment.data) {
                        self.apply_region(rcs);
                    }
                }
                CLUT_DEFINITION => {
                    if segment.data.is_empty() {
                        continue;
                    }
                    let clut_id = segment.data[0];
                    let clut = self
                        .cluts
                        .entry(clut_id)
                        .or_insert_with(|| Clut::default_clut(clut_id));
                    clut.apply_definition(segment.data);
                }
                OBJECT_DATA => {
                    self.apply_object(segment.data);
                }
                DISPLAY_DEFINITION => {
                    if let Some(dds) = DisplayDefinition::parse(segment.data) {
                        self.display_definition = Some(dds);
                    }
                }
                END_OF_DISPLAY_SET => {
                    saw_eds = true;
                }
                _ => {}
            }
        }

        saw_eds.then(|| self.compose_cue(pts_ms))
    }

    fn apply_region(&mut self, rcs: RegionComposition) {
        let pixels_needed = (rcs.width as usize).saturating_mul(rcs.height as usize);
        if pixels_needed == 0 || pixels_needed > MAX_DVB_BITMAP_PIXELS {
            return;
        }

        let depth = match rcs.depth {
            1 => 2,
            2 => 4,
            3 => 8,
            other => other,
        };

        let entry = self.regions.entry(rcs.region_id);
        let region = entry.or_insert_with(|| Region {
            version: -1,
            width: rcs.width,
            height: rcs.height,
            depth,
            clut_id: rcs.clut_id,
            bgcolor: rcs.bgcolor(),
            pixels: vec![rcs.bgcolor(); pixels_needed],
            objects: Vec::new(),
        });

        // Drop old object placements for this region.
        for (object_id, _, _) in &region.objects {
            if let Some(list) = self.object_placements.get_mut(object_id) {
                list.retain(|placement| placement.region_id != rcs.region_id);
            }
        }

        let version = rcs.version as i8;
        let size_changed = region.width != rcs.width || region.height != rcs.height;
        if size_changed || region.pixels.len() != pixels_needed {
            region.width = rcs.width;
            region.height = rcs.height;
            region.pixels = vec![rcs.bgcolor(); pixels_needed];
        } else if rcs.fill_flag {
            region.pixels.fill(rcs.bgcolor());
        }

        region.version = version;
        region.depth = depth;
        region.clut_id = rcs.clut_id;
        region.bgcolor = rcs.bgcolor();
        region.objects.clear();

        for object in rcs.objects {
            region.objects.push((object.object_id, object.x, object.y));
            self.object_placements
                .entry(object.object_id)
                .or_default()
                .push(ObjectPlacement {
                    region_id: rcs.region_id,
                    x: object.x,
                    y: object.y,
                });
        }
    }

    fn apply_object(&mut self, data: &[u8]) {
        if data.len() < 7 {
            return;
        }

        let object_id = u16::from_be_bytes([data[0], data[1]]);
        let coding_method = (data[2] >> 2) & 0x03;
        let non_mod = ((data[2] >> 1) & 0x01) != 0;

        if coding_method != 0 {
            return;
        }

        let top_field_len = u16::from_be_bytes([data[3], data[4]]) as usize;
        let bottom_field_len = u16::from_be_bytes([data[5], data[6]]) as usize;
        if 7 + top_field_len + bottom_field_len > data.len() {
            return;
        }

        let top_field = &data[7..7 + top_field_len];
        let bottom_field = if bottom_field_len > 0 {
            &data[7 + top_field_len..7 + top_field_len + bottom_field_len]
        } else {
            top_field
        };

        let placements = self
            .object_placements
            .get(&object_id)
            .cloned()
            .unwrap_or_default();

        for placement in placements {
            let Some(region) = self.regions.get_mut(&placement.region_id) else {
                continue;
            };

            decode_object_field(
                &mut region.pixels,
                region.width as usize,
                region.height as usize,
                ObjectField {
                    depth: region.depth,
                    x: placement.x as usize,
                    y: placement.y as usize,
                    data: top_field,
                    field_index: 0,
                    non_modifying: non_mod,
                },
            );

            let bottom = if bottom_field_len > 0 {
                bottom_field
            } else {
                top_field
            };
            decode_object_field(
                &mut region.pixels,
                region.width as usize,
                region.height as usize,
                ObjectField {
                    depth: region.depth,
                    x: placement.x as usize,
                    y: placement.y as usize,
                    data: bottom,
                    field_index: 1,
                    non_modifying: non_mod,
                },
            );
        }
    }

    fn compose_cue(&self, pts_ms: u32) -> DisplayCue {
        let (screen_width, screen_height) = self.screen_size();
        let Some(page) = self.page.as_ref() else {
            return DisplayCue {
                pts_ms,
                timeout_ms: 5000,
                page_state: 0,
                region_count: 0,
                screen_width,
                screen_height,
                frame: None,
            };
        };

        let timeout_ms = (page.timeout_seconds as u32).saturating_mul(1000);

        if page.regions.is_empty() {
            return DisplayCue {
                pts_ms,
                timeout_ms,
                page_state: page.state,
                region_count: 0,
                screen_width,
                screen_height,
                frame: None,
            };
        }

        const MAX_FRAME_PIXELS: usize = 16_777_216;
        const MAX_FRAME_COMPOSITIONS: usize = 256;
        let mut compositions = Vec::new();
        let mut total_pixels = 0usize;
        for region_ref in &page.regions {
            if compositions.len() >= MAX_FRAME_COMPOSITIONS {
                break;
            }
            let Some(region) = self.regions.get(&region_ref.region_id) else {
                continue;
            };

            let clut = self
                .cluts
                .get(&region.clut_id)
                .cloned()
                .unwrap_or_else(|| Clut::default_clut(region.clut_id));
            let palette = clut.entries_for_depth(region.depth);

            let Some(pixel_count) = (region.width as usize).checked_mul(region.height as usize)
            else {
                continue;
            };
            if pixel_count == 0 || region.pixels.len() < pixel_count {
                continue;
            }
            total_pixels = match total_pixels.checked_add(pixel_count) {
                Some(total) if total <= MAX_FRAME_PIXELS => total,
                _ => break,
            };

            let Some(rgba_len) = pixel_count.checked_mul(4) else {
                continue;
            };
            let mut rgba = vec![0u8; rgba_len];
            for (index, &code) in region.pixels[..pixel_count].iter().enumerate() {
                let color = palette.get(code as usize).copied().unwrap_or(0);
                let bytes = color.to_le_bytes();
                let dest = index * 4;
                rgba[dest] = bytes[0];
                rgba[dest + 1] = bytes[1];
                rgba[dest + 2] = bytes[2];
                rgba[dest + 3] = bytes[3];
            }

            let x = region_ref.x.saturating_add(
                self.display_definition
                    .as_ref()
                    .map(|dds| dds.window_x)
                    .unwrap_or(0),
            );
            let y = region_ref.y.saturating_add(
                self.display_definition
                    .as_ref()
                    .map(|dds| dds.window_y)
                    .unwrap_or(0),
            );

            compositions.push(DvbComposition {
                x,
                y,
                width: region.width,
                height: region.height,
                rgba,
            });
        }

        let frame = if compositions.is_empty() {
            None
        } else {
            Some(DvbFrame {
                width: screen_width,
                height: screen_height,
                compositions,
            })
        };

        DisplayCue {
            pts_ms,
            timeout_ms,
            page_state: page.state,
            region_count: page.regions.len() as u32,
            screen_width,
            screen_height,
            frame,
        }
    }
}

impl Default for DvbContext {
    fn default() -> Self {
        Self::new()
    }
}
