//! Stateful DVB composition buffer (regions, CLUTs, objects, page).

use std::collections::HashMap;
use std::sync::Arc;

use super::clut::Clut;
use super::pes::iter_segments;
use super::rle::{ObjectField, decode_object_field};
use super::segment::{
    CLUT_DEFINITION, DISPLAY_DEFINITION, DisplayDefinition, END_OF_DISPLAY_SET, OBJECT_DATA,
    PAGE_COMPOSITION, PAGE_STATE_ACQUISITION, PAGE_STATE_MODE_CHANGE, PageComposition,
    REGION_COMPOSITION, RegionComposition,
};
use super::{DEFAULT_SCREEN_HEIGHT, DEFAULT_SCREEN_WIDTH, MAX_DVB_BITMAP_PIXELS};

/// Object references kept per region (duplicates are coalesced).
const MAX_REGION_OBJECTS: usize = 256;
/// Placements decoded per object across all regions.
const MAX_OBJECT_PLACEMENTS: usize = 256;

#[derive(Debug, Clone)]
struct Region {
    version: i8,
    width: u16,
    height: u16,
    depth: u8,
    clut_id: u8,
    bgcolor: u8,
    /// Shared with cue snapshots; copied on write.
    pixels: Arc<Vec<u8>>,
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
struct RegionSnapshot {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    pixels: Arc<Vec<u8>>,
    palette: Vec<u32>,
}

/// Indexed snapshot of the page at a cue. Region planes are shared with the
/// context and other cues until modified; RGBA is produced on demand.
#[derive(Debug, Clone)]
pub struct CueSnapshot {
    width: u16,
    height: u16,
    regions: Vec<RegionSnapshot>,
}

impl CueSnapshot {
    pub fn composition_count(&self) -> usize {
        self.regions.len()
    }

    pub fn compose(&self) -> DvbFrame {
        let compositions = self
            .regions
            .iter()
            .map(|region| {
                let mut rgba = vec![0u8; region.pixels.len() * 4];
                for (dest, &code) in rgba.chunks_exact_mut(4).zip(region.pixels.iter()) {
                    let color = region.palette.get(code as usize).copied().unwrap_or(0);
                    dest.copy_from_slice(&color.to_le_bytes());
                }
                DvbComposition {
                    x: region.x,
                    y: region.y,
                    width: region.width,
                    height: region.height,
                    rgba,
                }
            })
            .collect();

        DvbFrame {
            width: self.width,
            height: self.height,
            compositions,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DisplayCue {
    pub pts_ms: u32,
    pub timeout_ms: u32,
    pub page_state: u8,
    pub region_count: u32,
    pub screen_width: u16,
    pub screen_height: u16,
    /// Snapshot of the page at this cue (None = clear screen).
    pub frame: Option<CueSnapshot>,
    /// Bytes this cue newly retains (overhead plus region planes not already
    /// held by an earlier cue).
    pub retained_bytes: usize,
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

        // The pixel budget applies to all regions together, not each one.
        let other_pixels: usize = self
            .regions
            .iter()
            .filter(|(id, _)| **id != rcs.region_id)
            .map(|(_, region)| region.pixels.len())
            .sum();
        if other_pixels + pixels_needed > MAX_DVB_BITMAP_PIXELS {
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
            pixels: Arc::new(vec![rcs.bgcolor(); pixels_needed]),
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
            region.pixels = Arc::new(vec![rcs.bgcolor(); pixels_needed]);
        } else if rcs.fill_flag {
            Arc::make_mut(&mut region.pixels).fill(rcs.bgcolor());
        }

        region.version = version;
        region.depth = depth;
        region.clut_id = rcs.clut_id;
        region.bgcolor = rcs.bgcolor();
        region.objects.clear();

        for object in rcs.objects {
            if region.objects.len() >= MAX_REGION_OBJECTS {
                break;
            }
            let placement = (object.object_id, object.x, object.y);
            if region.objects.contains(&placement) {
                continue;
            }
            region.objects.push(placement);
            let placements = self.object_placements.entry(object.object_id).or_default();
            if placements.len() < MAX_OBJECT_PLACEMENTS {
                placements.push(ObjectPlacement {
                    region_id: rcs.region_id,
                    x: object.x,
                    y: object.y,
                });
            }
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

        let Some(placements) = self.object_placements.get(&object_id) else {
            return;
        };

        for placement in placements {
            let Some(region) = self.regions.get_mut(&placement.region_id) else {
                continue;
            };
            let pixels = Arc::make_mut(&mut region.pixels);

            decode_object_field(
                pixels,
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
                pixels,
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
                retained_bytes: size_of::<DisplayCue>(),
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
                retained_bytes: size_of::<DisplayCue>(),
            };
        }

        const MAX_FRAME_PIXELS: usize = 16_777_216;
        const MAX_FRAME_COMPOSITIONS: usize = 256;
        let mut regions = Vec::new();
        let mut total_pixels = 0usize;
        let mut retained_bytes = size_of::<DisplayCue>();
        for region_ref in &page.regions {
            if regions.len() >= MAX_FRAME_COMPOSITIONS {
                break;
            }
            let Some(region) = self.regions.get(&region_ref.region_id) else {
                continue;
            };

            let palette = match self.cluts.get(&region.clut_id) {
                Some(clut) => clut.entries_for_depth(region.depth).to_vec(),
                None => Clut::default_clut(region.clut_id)
                    .entries_for_depth(region.depth)
                    .to_vec(),
            };

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

            // A plane only the context holds is newly retained by this cue.
            if Arc::strong_count(&region.pixels) == 1 {
                retained_bytes += region.pixels.len();
            }
            retained_bytes += size_of::<RegionSnapshot>() + palette.len() * size_of::<u32>();

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

            regions.push(RegionSnapshot {
                x,
                y,
                width: region.width,
                height: region.height,
                pixels: Arc::clone(&region.pixels),
                palette,
            });
        }

        let frame = if regions.is_empty() {
            None
        } else {
            Some(CueSnapshot {
                width: screen_width,
                height: screen_height,
                regions,
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
            retained_bytes,
        }
    }
}

impl Default for DvbContext {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dvb::segment::{PageRegionRef, RegionObjectRef};

    fn region(
        region_id: u8,
        width: u16,
        height: u16,
        objects: Vec<RegionObjectRef>,
    ) -> RegionComposition {
        RegionComposition {
            region_id,
            version: 0,
            fill_flag: false,
            width,
            height,
            depth: 3,
            clut_id: 0,
            region_level_8: 0,
            region_level_4: 0,
            region_level_2: 0,
            objects,
        }
    }

    fn object_ref(object_id: u16, x: u16, y: u16) -> RegionObjectRef {
        RegionObjectRef {
            object_id,
            object_type: 0,
            provider_flag: 0,
            x,
            y,
            foreground: 0,
            background: 0,
        }
    }

    fn show_region(context: &mut DvbContext, region_id: u8) {
        context.page = Some(PageComposition {
            timeout_seconds: 5,
            version: 0,
            state: 0,
            regions: vec![PageRegionRef {
                region_id,
                x: 0,
                y: 0,
            }],
        });
    }

    #[test]
    fn region_pixels_share_one_budget() {
        let mut context = DvbContext::new();
        context.apply_region(region(1, 4096, 4096, Vec::new()));
        context.apply_region(region(2, 1, 1, Vec::new()));

        assert!(context.regions.contains_key(&1));
        assert!(!context.regions.contains_key(&2));

        // Resizing the existing region does not count its old size twice.
        context.apply_region(region(1, 4096, 4095, Vec::new()));
        assert_eq!(context.regions[&1].pixels.len(), 4096 * 4095);
    }

    #[test]
    fn duplicate_object_references_are_coalesced_and_capped() {
        let mut context = DvbContext::new();
        let duplicates = vec![object_ref(7, 0, 0); 10_000];
        context.apply_region(region(1, 16, 16, duplicates));
        assert_eq!(context.regions[&1].objects.len(), 1);
        assert_eq!(context.object_placements[&7].len(), 1);

        let distinct = (0..1000).map(|x| object_ref(8, x, 0)).collect();
        context.apply_region(region(2, 16, 16, distinct));
        assert_eq!(context.regions[&2].objects.len(), MAX_REGION_OBJECTS);
        assert_eq!(context.object_placements[&8].len(), MAX_OBJECT_PLACEMENTS);
    }

    #[test]
    fn unchanged_regions_are_shared_between_cues() {
        let mut context = DvbContext::new();
        context.apply_region(region(1, 1024, 1024, Vec::new()));
        show_region(&mut context, 1);

        let first = context.compose_cue(0);
        assert!(first.retained_bytes > 1024 * 1024);

        // An end-of-display-set with no changes does not copy the region.
        let repeat = context.compose_cue(1000);
        assert!(repeat.retained_bytes < 4096);
        assert_eq!(Arc::strong_count(&context.regions[&1].pixels), 3);

        // Modifying the region copies it once and charges the new plane.
        let mut fill = region(1, 1024, 1024, Vec::new());
        fill.fill_flag = true;
        fill.region_level_8 = 5;
        context.apply_region(fill);
        let changed = context.compose_cue(2000);
        assert!(changed.retained_bytes > 1024 * 1024);

        let old = first.frame.expect("first frame").compose();
        let new = changed.frame.expect("changed frame").compose();
        assert_ne!(old.compositions[0].rgba, new.compositions[0].rgba);
    }
}
