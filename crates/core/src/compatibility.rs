//! Formal compatibility suite for PGS / VobSub / MKS correctness.
//!
//! Covers malformed payloads, palette edge cases, zero-length RLE runs,
//! alternate display sizes, and pixel-level golden frames so recent decoder
//! fixes stay locked in as durable guarantees.

#![cfg(test)]

use crate::pgs::{
    PgsParser, apply_palette_rgba_bytes, decode_rle_to_indexed, decode_rle_to_rgba,
};
use crate::utils::rgb_to_rgba;
use crate::vobsub::{
    SubtitlePacket, SubtitlePacketData, VobSubPalette, decode_vobsub_rle, extract_vobsub_from_mks,
    parse_idx,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// =============================================================================
// Fixture builders
// =============================================================================

fn push_be_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_be_u24(out: &mut Vec<u8>, value: u32) {
    out.push(((value >> 16) & 0xff) as u8);
    out.push(((value >> 8) & 0xff) as u8);
    out.push((value & 0xff) as u8);
}

fn push_be_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn write_pgs_segment(out: &mut Vec<u8>, pts: u32, segment_type: u8, payload: &[u8]) {
    push_be_u16(out, 0x5047);
    push_be_u32(out, pts);
    push_be_u32(out, 0);
    out.push(segment_type);
    push_be_u16(out, payload.len() as u16);
    out.extend_from_slice(payload);
}

/// Encode a solid rectangle as PGS RLE (palette index `color`).
fn encode_pgs_solid_rle(width: u16, height: u16, color: u8) -> Vec<u8> {
    let mut data = Vec::new();
    for _ in 0..height {
        let mut remaining = width as usize;
        while remaining > 0 {
            let run = remaining.min(63);
            if color == 0 {
                data.push(0x00);
                data.push(run as u8);
            } else {
                data.push(0x00);
                data.push(0x80 | run as u8);
                data.push(color);
            }
            remaining -= run;
        }
        data.extend_from_slice(&[0x00, 0x00]);
    }
    data
}

#[derive(Clone, Copy)]
struct PaletteEntry {
    id: u8,
    y: u8,
    cr: u8,
    cb: u8,
    a: u8,
}

fn build_pcs(
    width: u16,
    height: u16,
    composition_number: u16,
    object_id: u16,
    x: u16,
    y: u16,
) -> Vec<u8> {
    let mut pcs = Vec::new();
    push_be_u16(&mut pcs, width);
    push_be_u16(&mut pcs, height);
    pcs.push(0x10);
    push_be_u16(&mut pcs, composition_number);
    pcs.push(0x80);
    pcs.push(0x00);
    pcs.push(0x00);
    pcs.push(0x01);
    push_be_u16(&mut pcs, object_id);
    pcs.push(0x00);
    pcs.push(0x00);
    push_be_u16(&mut pcs, x);
    push_be_u16(&mut pcs, y);
    pcs
}

fn build_wds(window_id: u8, x: u16, y: u16, width: u16, height: u16) -> Vec<u8> {
    let mut wds = Vec::new();
    wds.push(0x01);
    wds.push(window_id);
    push_be_u16(&mut wds, x);
    push_be_u16(&mut wds, y);
    push_be_u16(&mut wds, width);
    push_be_u16(&mut wds, height);
    wds
}

fn build_pds(entries: &[PaletteEntry]) -> Vec<u8> {
    let mut pds = Vec::new();
    pds.push(0x00);
    pds.push(0x00);
    for entry in entries {
        pds.push(entry.id);
        pds.push(entry.y);
        pds.push(entry.cr);
        pds.push(entry.cb);
        pds.push(entry.a);
    }
    pds
}

fn build_ods(object_id: u16, width: u16, height: u16, rle: &[u8]) -> Vec<u8> {
    let mut ods = Vec::new();
    push_be_u16(&mut ods, object_id);
    ods.push(0x00);
    ods.push(0xC0);
    let data_length = 4u32 + rle.len() as u32;
    push_be_u24(&mut ods, data_length);
    push_be_u16(&mut ods, width);
    push_be_u16(&mut ods, height);
    ods.extend_from_slice(rle);
    ods
}

/// Build a minimal valid single-cue PGS (.sup) binary.
fn build_pgs_sup(
    pts: u32,
    screen_w: u16,
    screen_h: u16,
    obj_w: u16,
    obj_h: u16,
    obj_x: u16,
    obj_y: u16,
    color_index: u8,
    palette: &[PaletteEntry],
) -> Vec<u8> {
    let rle = encode_pgs_solid_rle(obj_w, obj_h, color_index);
    let mut out = Vec::new();
    write_pgs_segment(
        &mut out,
        pts,
        0x16,
        &build_pcs(screen_w, screen_h, 0, 1, obj_x, obj_y),
    );
    write_pgs_segment(
        &mut out,
        pts,
        0x17,
        &build_wds(0, obj_x, obj_y, obj_w, obj_h),
    );
    write_pgs_segment(&mut out, pts, 0x14, &build_pds(palette));
    write_pgs_segment(&mut out, pts, 0x15, &build_ods(1, obj_w, obj_h, &rle));
    write_pgs_segment(&mut out, pts, 0x80, &[]);
    out
}

fn default_white_on_black_palette() -> Vec<PaletteEntry> {
    vec![
        PaletteEntry {
            id: 0,
            y: 16,
            cr: 128,
            cb: 128,
            a: 0,
        },
        PaletteEntry {
            id: 1,
            y: 235,
            cr: 128,
            cb: 128,
            a: 255,
        },
        PaletteEntry {
            id: 255,
            y: 81,
            cr: 90,
            cb: 240,
            a: 255,
        },
    ]
}

fn build_idx(
    width: u16,
    height: u16,
    palette_hex: &[&str],
    timestamp_ms: u32,
    file_pos: u32,
) -> String {
    let mut idx = String::new();
    idx.push_str("# VobSub index file, v7 (compatibility fixture)\n");
    idx.push_str(&format!("size: {width}x{height}\n"));
    idx.push_str("palette: ");
    idx.push_str(&palette_hex.join(", "));
    idx.push('\n');
    let hours = timestamp_ms / 3_600_000;
    let minutes = (timestamp_ms / 60_000) % 60;
    let seconds = (timestamp_ms / 1000) % 60;
    let millis = timestamp_ms % 1000;
    idx.push_str(&format!(
        "timestamp: {hours:02}:{minutes:02}:{seconds:02}:{millis:03}, filepos: {file_pos:09x}\n"
    ));
    idx
}

fn build_vobsub_eol_field(color_idx: u8) -> Vec<u8> {
    let n3 = color_idx & 0x03;
    vec![0x00, n3]
}

fn build_owned_packet(
    width: u16,
    height: u16,
    color_indices: [u8; 4],
    alpha_values: [u8; 4],
    even_field: Vec<u8>,
    odd_field: Vec<u8>,
) -> SubtitlePacket {
    let mut owned = even_field.clone();
    let even_end = owned.len();
    owned.extend_from_slice(&odd_field);
    let odd_end = owned.len();
    SubtitlePacket {
        timestamp_ms: 0,
        duration_ms: 1000,
        x: 10,
        y: 20,
        width,
        height,
        color_indices,
        alpha_values,
        packet_data: SubtitlePacketData::Owned(owned),
        even_field_range: 0..even_end,
        odd_field_range: even_end..odd_end,
    }
}

fn encode_ebml_vint(value: u64) -> Vec<u8> {
    for width in 1..=8 {
        let max_value = if width == 8 {
            u64::MAX >> 8
        } else {
            (1u64 << (width * 7)) - 2
        };
        if value <= max_value {
            let mut bytes = vec![0u8; width];
            let mut temp = value;
            for index in (0..width).rev() {
                bytes[index] = (temp & 0xff) as u8;
                temp >>= 8;
            }
            bytes[0] |= 1 << (8 - width);
            return bytes;
        }
    }
    panic!("value too large for EBML vint");
}

fn encode_element_id(id: u32) -> Vec<u8> {
    if id > 0x00ff_ffff {
        vec![
            ((id >> 24) & 0xff) as u8,
            ((id >> 16) & 0xff) as u8,
            ((id >> 8) & 0xff) as u8,
            (id & 0xff) as u8,
        ]
    } else if id > 0x0000_ffff {
        vec![
            ((id >> 16) & 0xff) as u8,
            ((id >> 8) & 0xff) as u8,
            (id & 0xff) as u8,
        ]
    } else if id > 0x0000_00ff {
        vec![((id >> 8) & 0xff) as u8, (id & 0xff) as u8]
    } else {
        vec![id as u8]
    }
}

fn ebml_element(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = encode_element_id(id);
    out.extend_from_slice(&encode_ebml_vint(payload.len() as u64));
    out.extend_from_slice(payload);
    out
}

fn build_mks_with_track(
    codec_id: &[u8],
    codec_private: &[u8],
    language: &str,
    track_type: u8,
    payload: Option<&[u8]>,
) -> Vec<u8> {
    let ebml_header = ebml_element(0x1a45_dfa3, &ebml_element(0x4282, b"matroska"));
    let info = ebml_element(0x1549_a966, &ebml_element(0x2ad7_b1, &[0x0f, 0x42, 0x40]));

    let mut track_children = Vec::new();
    track_children.extend_from_slice(&ebml_element(0xd7, &[0x01]));
    track_children.extend_from_slice(&ebml_element(0x83, &[track_type]));
    track_children.extend_from_slice(&ebml_element(0x86, codec_id));
    if !codec_private.is_empty() {
        track_children.extend_from_slice(&ebml_element(0x63a2, codec_private));
    }
    track_children.extend_from_slice(&ebml_element(0x22b5_9c, language.as_bytes()));
    let tracks = ebml_element(0x1654_ae6b, &ebml_element(0xae, &track_children));

    let mut segment_payload = Vec::new();
    segment_payload.extend_from_slice(&info);
    segment_payload.extend_from_slice(&tracks);

    if let Some(block_payload) = payload {
        let mut simple_block = vec![0x81];
        simple_block.extend_from_slice(&0i16.to_be_bytes());
        simple_block.push(0x80);
        simple_block.extend_from_slice(block_payload);
        let cluster = ebml_element(
            0x1f43_b675,
            &[ebml_element(0xe7, &[0x00]), ebml_element(0xa3, &simple_block)].concat(),
        );
        segment_payload.extend_from_slice(&cluster);
    }

    let segment = ebml_element(0x1853_8067, &segment_payload);
    [ebml_header, segment].concat()
}

fn rgba_fingerprint(pixels: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    pixels.hash(&mut hasher);
    hasher.finish()
}

fn assert_all_pixels_eq(rgba: &[u8], expected: [u8; 4]) {
    assert!(!rgba.is_empty(), "expected non-empty pixel buffer");
    assert_eq!(rgba.len() % 4, 0);
    for pixel in rgba.chunks_exact(4) {
        assert_eq!(pixel, expected, "pixel mismatch against golden color");
    }
}

// =============================================================================
// Malformed payload fixtures
// =============================================================================

#[test]
fn malformed_pgs_bad_magic_is_ignored() {
    let mut parser = PgsParser::new();
    let junk = b"NOT_A_PGS_FILE\x00\x00\x00";
    assert_eq!(parser.parse(junk), 0);
    assert_eq!(parser.count(), 0);
}

#[test]
fn malformed_pgs_truncated_segment_does_not_panic() {
    let mut data = build_pgs_sup(
        90_000,
        720,
        480,
        8,
        4,
        10,
        20,
        1,
        &default_white_on_black_palette(),
    );
    data.truncate(data.len() / 2);

    let mut parser = PgsParser::new();
    let _ = parser.parse(&data);
    assert!(parser.count() <= 1);
}

#[test]
fn malformed_pgs_ods_length_mismatch_skips_object() {
    let mut out = Vec::new();
    let pts = 90_000u32;
    write_pgs_segment(&mut out, pts, 0x16, &build_pcs(720, 480, 0, 1, 0, 0));
    write_pgs_segment(&mut out, pts, 0x17, &build_wds(0, 0, 0, 8, 4));
    write_pgs_segment(
        &mut out,
        pts,
        0x14,
        &build_pds(&default_white_on_black_palette()),
    );

    let mut ods = Vec::new();
    push_be_u16(&mut ods, 1);
    ods.push(0x00);
    ods.push(0xC0);
    push_be_u24(&mut ods, 1_000_000);
    push_be_u16(&mut ods, 8);
    push_be_u16(&mut ods, 4);
    ods.extend_from_slice(&[0x01, 0x00, 0x00]);
    write_pgs_segment(&mut out, pts, 0x15, &ods);
    write_pgs_segment(&mut out, pts, 0x80, &[]);

    let mut parser = PgsParser::new();
    assert_eq!(parser.parse(&out), 1);
    let frame = parser.render_at_index(0).expect("frame shell should exist");
    assert_eq!(frame.composition_count(), 0);
}

#[test]
fn malformed_mks_without_vobsub_track_is_rejected() {
    let mks = build_mks_with_track(b"S_TEXT/UTF8", b"", "eng", 0x11, None);
    let err = extract_vobsub_from_mks(&mks).expect_err("non-vobsub track must fail");
    assert!(
        err.contains("S_VOBSUB") || err.to_lowercase().contains("track"),
        "unexpected error: {err}"
    );
}

#[test]
fn malformed_mks_empty_block_payload_is_rejected() {
    let idx = "size: 720x480\npalette: 000000, ffffff, 808080, 404040\n";
    let mks = build_mks_with_track(b"S_VOBSUB", idx.as_bytes(), "eng", 0x11, Some(&[]));
    let err = extract_vobsub_from_mks(&mks).expect_err("empty blocks must fail");
    assert!(
        err.to_lowercase().contains("no subtitle")
            || err.to_lowercase().contains("block")
            || err.to_lowercase().contains("empty")
            || err.to_lowercase().contains("length")
            || err.to_lowercase().contains("packet"),
        "unexpected error: {err}"
    );
}

#[test]
fn malformed_idx_missing_palette_still_parses_timestamps() {
    let idx = "size: 720x480\ntimestamp: 00:00:01:000, filepos: 000000000\n";
    let parsed = parse_idx(idx);
    assert_eq!(parsed.timestamps.len(), 1);
    assert_eq!(parsed.timestamps[0].timestamp_ms, 1000);
}

// =============================================================================
// Palette edge cases
// =============================================================================

#[test]
fn palette_high_index_255_is_addressable() {
    let palette = default_white_on_black_palette();
    let sup = build_pgs_sup(90_000, 720, 480, 4, 2, 0, 0, 255, &palette);
    let mut parser = PgsParser::new();
    assert_eq!(parser.parse(&sup), 1);
    let frame = parser.render_at_index(0).expect("frame");
    assert_eq!(frame.composition_count(), 1);
    let comp = frame.get_composition(0).expect("composition");
    let rgba = comp.get_rgba();
    assert_eq!(rgba.len(), 4 * 2 * 4);
    assert_eq!(rgba[3], 255, "alpha must come from palette entry 255");
}

#[test]
fn palette_out_of_range_index_decodes_as_transparent_black() {
    let mut palette = vec![0u32; 4];
    palette[1] = rgb_to_rgba(255, 255, 255, 255);
    let indexed = [200u8, 1, 200, 1];
    let mut rgba = vec![0u8; indexed.len() * 4];
    apply_palette_rgba_bytes(&indexed, &palette, &mut rgba);
    assert_eq!(&rgba[0..4], &[0, 0, 0, 0]);
    assert_eq!(&rgba[4..8], &[255, 255, 255, 255]);
    assert_eq!(&rgba[8..12], &[0, 0, 0, 0]);
    assert_eq!(&rgba[12..16], &[255, 255, 255, 255]);
}

#[test]
fn palette_empty_entries_remain_transparent() {
    let palette = vec![0u32; 256];
    let indexed = [0u8, 0, 0, 0];
    let mut rgba = vec![0xffu8; 16];
    apply_palette_rgba_bytes(&indexed, &palette, &mut rgba);
    assert_all_pixels_eq(&rgba, [0, 0, 0, 0]);
}

// =============================================================================
// Zero-length RLE runs
// =============================================================================

#[test]
fn pgs_zero_length_color_run_does_not_hang_or_write() {
    let data = [0x00, 0x80, 0x07, 0x01];
    let mut target = vec![0xffu8; 8];
    let count = decode_rle_to_indexed(&data, &mut target);
    assert_eq!(count, 1, "only the trailing literal should write");
    assert_eq!(target[0], 1);
    assert_eq!(target[1], 0xff, "zero-length run must not clobber buffer");
}

#[test]
fn pgs_zero_length_transparent_run_before_literal() {
    let data = [0x00, 0x40, 0x00, 0x03];
    let mut target = vec![0xffu8; 4];
    let count = decode_rle_to_indexed(&data, &mut target);
    assert_eq!(count, 1);
    assert_eq!(target[0], 3);
}

#[test]
fn pgs_zero_length_run_rgba_path_matches_indexed() {
    let data = [0x00, 0x80, 0x02, 0x01];
    let palette = [0u32, rgb_to_rgba(10, 20, 30, 255)];
    let mut indexed = vec![0u8; 4];
    let mut rgba = vec![0u32; 4];
    let c1 = decode_rle_to_indexed(&data, &mut indexed);
    let c2 = decode_rle_to_rgba(&data, &palette, &mut rgba);
    assert_eq!(c1, c2);
    assert_eq!(c1, 1);
    assert_eq!(indexed[0], 1);
    assert_eq!(rgba[0], palette[1]);
}

#[test]
fn vobsub_zero_length_run_is_end_of_line_with_code_color() {
    let packet = build_owned_packet(
        6,
        1,
        [0, 1, 2, 3],
        [0, 15, 15, 15],
        build_vobsub_eol_field(2),
        Vec::new(),
    );
    let mut palette = VobSubPalette::default();
    palette.rgba[2] = rgb_to_rgba(1, 2, 3, 255);
    let rgba = decode_vobsub_rle(&packet, &[], &palette);
    assert_eq!(rgba.len(), 6 * 4);
    assert_all_pixels_eq(&rgba, [1, 2, 3, 255]);
}

// =============================================================================
// Alternate display sizes
// =============================================================================

#[test]
fn alternate_display_sizes_parse_and_report_screen_metrics() {
    let cases = [
        (720u16, 480u16),
        (1280, 720),
        (1920, 1080),
        (3840, 2160),
    ];

    for (width, height) in cases {
        let sup = build_pgs_sup(
            90_000,
            width,
            height,
            8,
            4,
            16,
            32,
            1,
            &default_white_on_black_palette(),
        );
        let mut parser = PgsParser::new();
        assert_eq!(parser.parse(&sup), 1, "{width}x{height}");
        assert_eq!(parser.screen_width(), width);
        assert_eq!(parser.screen_height(), height);

        let frame = parser.render_at_index(0).expect("frame");
        assert_eq!(frame.width(), width);
        assert_eq!(frame.height(), height);
        assert_eq!(frame.composition_count(), 1);
        let comp = frame.get_composition(0).unwrap();
        assert_eq!(comp.width(), 8);
        assert_eq!(comp.height(), 4);
        assert_eq!(comp.x(), 16);
        assert_eq!(comp.y(), 32);
    }
}

#[test]
fn vobsub_idx_alternate_sizes_are_reflected_in_metadata() {
    for (width, height) in [(720u16, 480u16), (1920, 1080)] {
        let idx = build_idx(
            width,
            height,
            &["000000", "ffffff", "808080", "404040"],
            0,
            0,
        );
        let parsed = parse_idx(&idx);
        assert_eq!(parsed.metadata.width, width);
        assert_eq!(parsed.metadata.height, height);
    }
}

// =============================================================================
// Pixel-level golden frames (software decoder path)
// =============================================================================

#[test]
fn golden_pgs_solid_near_white_block() {
    let sup = build_pgs_sup(
        90_000,
        320,
        240,
        4,
        2,
        0,
        0,
        1,
        &default_white_on_black_palette(),
    );
    let mut parser = PgsParser::new();
    assert_eq!(parser.parse(&sup), 1);
    let frame = parser.render_at_index(0).expect("frame");
    let comp = frame.get_composition(0).expect("comp");
    let rgba = comp.get_rgba();

    assert_eq!(rgba.len(), 4 * 2 * 4);
    // Studio-range white (Y=235, Cb=Cr=128) maps to RGB(235,235,235).
    for pixel in rgba.chunks_exact(4) {
        assert_eq!(pixel, [235, 235, 235, 255]);
    }

    let fp = rgba_fingerprint(rgba);
    let mut parser2 = PgsParser::new();
    parser2.parse(&sup);
    let rgba2 = parser2
        .render_at_index(0)
        .unwrap()
        .get_composition(0)
        .unwrap()
        .get_rgba()
        .to_vec();
    assert_eq!(rgba, rgba2.as_slice());
    assert_eq!(rgba_fingerprint(&rgba2), fp);
}

#[test]
fn golden_pgs_transparent_object_is_fully_clear() {
    let palette = default_white_on_black_palette();
    let sup = build_pgs_sup(90_000, 320, 240, 4, 2, 0, 0, 0, &palette);
    let mut parser = PgsParser::new();
    parser.parse(&sup);
    let rgba = parser
        .render_at_index(0)
        .unwrap()
        .get_composition(0)
        .unwrap()
        .get_rgba()
        .to_vec();
    // Transparent palette entry keeps converted YCbCr RGB with A=0.
    assert_all_pixels_eq(&rgba, [16, 16, 16, 0]);
}

#[test]
fn golden_vobsub_eol_fill_is_deterministic() {
    let packet = build_owned_packet(
        8,
        2,
        [0, 1, 2, 3],
        [0, 15, 15, 15],
        build_vobsub_eol_field(1),
        build_vobsub_eol_field(1),
    );
    let mut palette = VobSubPalette::default();
    palette.rgba[1] = rgb_to_rgba(200, 100, 50, 255);
    let rgba = decode_vobsub_rle(&packet, &[], &palette);
    assert_eq!(rgba.len(), 8 * 2 * 4);
    assert_all_pixels_eq(&rgba, [200, 100, 50, 255]);
}

#[test]
fn fixture_roundtrip_screen_sizes_produce_distinct_metadata() {
    let a = build_pgs_sup(0, 720, 480, 2, 2, 0, 0, 1, &default_white_on_black_palette());
    let b = build_pgs_sup(0, 1920, 1080, 2, 2, 0, 0, 1, &default_white_on_black_palette());
    let mut pa = PgsParser::new();
    let mut pb = PgsParser::new();
    pa.parse(&a);
    pb.parse(&b);
    assert_ne!(
        (pa.screen_width(), pa.screen_height()),
        (pb.screen_width(), pb.screen_height())
    );
}
