//! DVB object pixel-string RLE decoding (2/4/8-bit).

struct BitReader<'a> {
    data: &'a [u8],
    bit_pos: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, bit_pos: 0 }
    }

    fn bits_left(&self) -> usize {
        self.data
            .len()
            .saturating_mul(8)
            .saturating_sub(self.bit_pos)
    }

    fn get_bits(&mut self, n: usize) -> Option<u32> {
        if n == 0 {
            return Some(0);
        }
        if self.bits_left() < n {
            return None;
        }

        let mut value = 0u32;
        for _ in 0..n {
            let byte_index = self.bit_pos / 8;
            let bit_index = 7 - (self.bit_pos % 8);
            let bit = (self.data[byte_index] >> bit_index) & 1;
            value = (value << 1) | u32::from(bit);
            self.bit_pos += 1;
        }
        Some(value)
    }

    fn get_bit(&mut self) -> Option<u32> {
        self.get_bits(1)
    }

    fn byte_pos(&self) -> usize {
        self.bit_pos.div_ceil(8)
    }
}

pub struct ObjectField<'a> {
    pub depth: u8,
    pub x: usize,
    pub y: usize,
    pub data: &'a [u8],
    pub field_index: usize,
    pub non_modifying: bool,
}

fn write_run(
    dest: &mut [u8],
    pixels_read: &mut usize,
    width: usize,
    value: u8,
    run_length: usize,
    non_mod: bool,
) {
    if non_mod && value == 1 {
        *pixels_read = (*pixels_read + run_length).min(width);
        return;
    }

    let mut remaining = run_length;
    while remaining > 0 && *pixels_read < width {
        dest[*pixels_read] = value;
        *pixels_read += 1;
        remaining -= 1;
    }
}

fn map_value(map_table: Option<&[u8]>, value: u8) -> u8 {
    map_table
        .and_then(|table| table.get(value as usize).copied())
        .unwrap_or(value)
}

pub fn read_2bit_string(
    dest: &mut [u8],
    src: &[u8],
    non_mod: bool,
    map_table: Option<&[u8]>,
    mut x_pos: usize,
) -> (usize, usize) {
    let width = dest.len();
    let mut reader = BitReader::new(src);

    while reader.bits_left() >= 2 && x_pos < width {
        let bits = reader.get_bits(2).unwrap_or(0) as u8;
        if bits != 0 {
            if !(non_mod && bits == 1) {
                dest[x_pos] = map_value(map_table, bits);
            }
            x_pos += 1;
            continue;
        }

        let flag = reader.get_bit().unwrap_or(0);
        if flag == 1 {
            let run_length = reader.get_bits(3).unwrap_or(0) as usize + 3;
            let value = reader.get_bits(2).unwrap_or(0) as u8;
            write_run(
                dest,
                &mut x_pos,
                width,
                map_value(map_table, value),
                run_length,
                non_mod,
            );
        } else {
            let flag2 = reader.get_bit().unwrap_or(0);
            if flag2 == 0 {
                let code = reader.get_bits(2).unwrap_or(0);
                match code {
                    2 => {
                        let run_length = reader.get_bits(4).unwrap_or(0) as usize + 12;
                        let value = reader.get_bits(2).unwrap_or(0) as u8;
                        write_run(
                            dest,
                            &mut x_pos,
                            width,
                            map_value(map_table, value),
                            run_length,
                            non_mod,
                        );
                    }
                    3 => {
                        let run_length = reader.get_bits(8).unwrap_or(0) as usize + 29;
                        let value = reader.get_bits(2).unwrap_or(0) as u8;
                        write_run(
                            dest,
                            &mut x_pos,
                            width,
                            map_value(map_table, value),
                            run_length,
                            non_mod,
                        );
                    }
                    1 => {
                        write_run(dest, &mut x_pos, width, map_value(map_table, 0), 2, false);
                    }
                    _ => {
                        return (x_pos, reader.byte_pos());
                    }
                }
            } else {
                write_run(dest, &mut x_pos, width, map_value(map_table, 0), 1, false);
            }
        }
    }

    let _ = reader.get_bits(6.min(reader.bits_left()));
    (x_pos, reader.byte_pos())
}

pub fn read_4bit_string(
    dest: &mut [u8],
    src: &[u8],
    non_mod: bool,
    map_table: Option<&[u8]>,
    mut x_pos: usize,
) -> (usize, usize) {
    let width = dest.len();
    let mut reader = BitReader::new(src);

    while reader.bits_left() >= 4 && x_pos < width {
        let bits = reader.get_bits(4).unwrap_or(0) as u8;
        if bits != 0 {
            if !(non_mod && bits == 1) {
                dest[x_pos] = map_value(map_table, bits);
            }
            x_pos += 1;
            continue;
        }

        let flag = reader.get_bit().unwrap_or(0);
        if flag == 0 {
            let run_length = reader.get_bits(3).unwrap_or(0) as usize;
            if run_length == 0 {
                return (x_pos, reader.byte_pos());
            }
            write_run(
                dest,
                &mut x_pos,
                width,
                map_value(map_table, 0),
                run_length + 2,
                false,
            );
        } else {
            let flag2 = reader.get_bit().unwrap_or(0);
            if flag2 == 0 {
                let run_length = reader.get_bits(2).unwrap_or(0) as usize + 4;
                let value = reader.get_bits(4).unwrap_or(0) as u8;
                write_run(
                    dest,
                    &mut x_pos,
                    width,
                    map_value(map_table, value),
                    run_length,
                    non_mod,
                );
            } else {
                let code = reader.get_bits(2).unwrap_or(0);
                match code {
                    2 => {
                        let run_length = reader.get_bits(4).unwrap_or(0) as usize + 9;
                        let value = reader.get_bits(4).unwrap_or(0) as u8;
                        write_run(
                            dest,
                            &mut x_pos,
                            width,
                            map_value(map_table, value),
                            run_length,
                            non_mod,
                        );
                    }
                    3 => {
                        let run_length = reader.get_bits(8).unwrap_or(0) as usize + 25;
                        let value = reader.get_bits(4).unwrap_or(0) as u8;
                        write_run(
                            dest,
                            &mut x_pos,
                            width,
                            map_value(map_table, value),
                            run_length,
                            non_mod,
                        );
                    }
                    1 => {
                        write_run(dest, &mut x_pos, width, map_value(map_table, 0), 2, false);
                    }
                    _ => {
                        write_run(dest, &mut x_pos, width, map_value(map_table, 0), 1, false);
                    }
                }
            }
        }
    }

    let _ = reader.get_bits(8.min(reader.bits_left()));
    (x_pos, reader.byte_pos())
}

pub fn read_8bit_string(
    dest: &mut [u8],
    src: &[u8],
    non_mod: bool,
    mut x_pos: usize,
) -> (usize, usize) {
    let width = dest.len();
    let mut offset = 0usize;

    while offset < src.len() && x_pos < width {
        let bits = src[offset];
        offset += 1;

        if bits != 0 {
            if !(non_mod && bits == 1) {
                dest[x_pos] = bits;
            }
            x_pos += 1;
            continue;
        }

        if offset >= src.len() {
            break;
        }
        let next = src[offset];
        offset += 1;
        let run_length = (next & 0x7F) as usize;
        if next & 0x80 == 0 {
            if run_length == 0 {
                return (x_pos, offset);
            }
            write_run(dest, &mut x_pos, width, 0, run_length, false);
        } else {
            if offset >= src.len() {
                break;
            }
            let value = src[offset];
            offset += 1;
            write_run(dest, &mut x_pos, width, value, run_length, non_mod);
        }
    }

    if offset < src.len() {
        offset += 1;
    }
    (x_pos, offset)
}

/// Decode a bitmap object field into an interlaced region buffer.
pub fn decode_object_field(
    region: &mut [u8],
    region_width: usize,
    region_height: usize,
    object: ObjectField<'_>,
) {
    let ObjectField {
        depth,
        x: obj_x,
        y: obj_y,
        data: field,
        field_index: top_bottom,
        non_modifying: non_mod,
    } = object;
    let mut map2to4 = [0x0, 0x7, 0x8, 0xf];
    let mut map2to8 = [0x00, 0x77, 0x88, 0xff];
    let mut map4to8 = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
    ];

    let mut offset = 0usize;
    let mut x_pos = obj_x;
    let mut y_pos = obj_y + top_bottom;

    while offset < field.len() {
        if y_pos >= region_height {
            break;
        }
        if field[offset] != 0xF0 && x_pos >= region_width {
            break;
        }

        let code = field[offset];
        offset += 1;

        match code {
            0x10 => {
                let map = if depth == 8 {
                    Some(map2to8.as_slice())
                } else if depth == 4 {
                    Some(map2to4.as_slice())
                } else {
                    None
                };
                let line_start = y_pos * region_width;
                let line_end = line_start + region_width;
                if line_end > region.len() {
                    break;
                }
                let (new_x, consumed) = read_2bit_string(
                    &mut region[line_start..line_end],
                    &field[offset..],
                    non_mod,
                    map,
                    x_pos,
                );
                x_pos = new_x;
                offset += consumed;
            }
            0x11 => {
                if depth < 4 {
                    break;
                }
                let map = if depth == 8 {
                    Some(map4to8.as_slice())
                } else {
                    None
                };
                let line_start = y_pos * region_width;
                let line_end = line_start + region_width;
                if line_end > region.len() {
                    break;
                }
                let (new_x, consumed) = read_4bit_string(
                    &mut region[line_start..line_end],
                    &field[offset..],
                    non_mod,
                    map,
                    x_pos,
                );
                x_pos = new_x;
                offset += consumed;
            }
            0x12 => {
                if depth < 8 {
                    break;
                }
                let line_start = y_pos * region_width;
                let line_end = line_start + region_width;
                if line_end > region.len() {
                    break;
                }
                let (new_x, consumed) = read_8bit_string(
                    &mut region[line_start..line_end],
                    &field[offset..],
                    non_mod,
                    x_pos,
                );
                x_pos = new_x;
                offset += consumed;
            }
            0x20 => {
                if offset + 2 > field.len() {
                    break;
                }
                map2to4[0] = field[offset] >> 4;
                map2to4[1] = field[offset] & 0x0F;
                map2to4[2] = field[offset + 1] >> 4;
                map2to4[3] = field[offset + 1] & 0x0F;
                offset += 2;
            }
            0x21 => {
                if offset + 4 > field.len() {
                    break;
                }
                map2to8.copy_from_slice(&field[offset..offset + 4]);
                offset += 4;
            }
            0x22 => {
                if offset + 16 > field.len() {
                    break;
                }
                map4to8.copy_from_slice(&field[offset..offset + 16]);
                offset += 16;
            }
            0xF0 => {
                x_pos = obj_x;
                y_pos += 2;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eight_bit_single_pixels_and_end() {
        let mut dest = [0u8; 8];
        // pixels 3, 4, then end-of-string (0x00 0x00)
        let src = [0x03, 0x04, 0x00, 0x00];
        let (x, consumed) = read_8bit_string(&mut dest, &src, false, 0);
        assert_eq!(x, 2);
        assert_eq!(dest[0], 3);
        assert_eq!(dest[1], 4);
        assert!(consumed >= 3);
    }
}
