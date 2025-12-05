//! VobSub IDX file parser.
//!
//! The IDX file contains timing information, palette data, and metadata.

use crate::utils::rgb_to_rgba;

/// VobSub palette (16 RGBA colors).
#[derive(Debug, Clone)]
pub struct VobSubPalette {
    /// 16 RGBA colors (packed as u32 in little-endian: R, G, B, A bytes)
    pub rgba: [u32; 16],
}

impl Default for VobSubPalette {
    fn default() -> Self {
        // Default grayscale palette
        Self {
            rgba: [
                0x00000000, // Transparent
                0xFFFFFFFF, // White
                0xFF000000, // Black (with alpha)
                0xFF808080, // Gray
                0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000,
                0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000,
            ],
        }
    }
}

/// VobSub timestamp entry.
#[derive(Debug, Clone, Copy)]
pub struct VobSubTimestamp {
    /// Timestamp in milliseconds
    pub timestamp_ms: u32,
    /// File position in the .sub file
    pub file_position: u64,
}

/// VobSub metadata.
#[derive(Debug, Clone)]
pub struct VobSubMetadata {
    /// Video width
    pub width: u16,
    /// Video height
    pub height: u16,
    /// Language code (if specified)
    pub language: Option<String>,
    /// Subtitle track ID
    pub id: Option<String>,
}

impl Default for VobSubMetadata {
    fn default() -> Self {
        Self {
            width: 720,
            height: 480,
            language: None,
            id: None,
        }
    }
}

/// Parsed IDX file data.
#[derive(Debug, Clone)]
pub struct IdxParseResult {
    pub palette: VobSubPalette,
    pub timestamps: Vec<VobSubTimestamp>,
    pub metadata: VobSubMetadata,
}

/// Parse a VobSub IDX file.
pub fn parse_idx(idx_content: &str) -> IdxParseResult {
    let mut result = IdxParseResult {
        palette: VobSubPalette::default(),
        timestamps: Vec::new(),
        metadata: VobSubMetadata::default(),
    };

    for line in idx_content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Parse size
        if let Some(rest) = trimmed.strip_prefix("size:") {
            if let Some((w_str, h_str)) = rest.trim().split_once('x') {
                if let (Ok(w), Ok(h)) = (w_str.trim().parse::<u16>(), h_str.trim().parse::<u16>()) {
                    result.metadata.width = w;
                    result.metadata.height = h;
                }
            }
            continue;
        }

        // Parse palette
        if let Some(rest) = trimmed.strip_prefix("palette:") {
            let colors: Vec<&str> = rest.split(',').map(|s| s.trim()).collect();
            for (i, color_hex) in colors.iter().enumerate().take(16) {
                let hex = color_hex.trim_start_matches('#');
                if hex.len() == 6 {
                    if let Ok(rgb) = u32::from_str_radix(hex, 16) {
                        let r = ((rgb >> 16) & 0xFF) as u8;
                        let g = ((rgb >> 8) & 0xFF) as u8;
                        let b = (rgb & 0xFF) as u8;
                        result.palette.rgba[i] = rgb_to_rgba(r, g, b, 255);
                    }
                }
            }
            continue;
        }

        // Parse language ID
        if let Some(rest) = trimmed.strip_prefix("id:") {
            let parts: Vec<&str> = rest.split(',').collect();
            if !parts.is_empty() {
                result.metadata.language = Some(parts[0].trim().to_string());
            }
            if let Some(idx_part) = parts.get(1) {
                if let Some(idx_str) = idx_part.trim().strip_prefix("index:") {
                    result.metadata.id = Some(idx_str.trim().to_string());
                }
            }
            continue;
        }

        // Parse timestamp entries
        // Format: timestamp: HH:MM:SS:mmm, filepos: XXXXXXXX
        if let Some(rest) = trimmed.strip_prefix("timestamp:") {
            if let Some((time_part, filepos_part)) = rest.split_once(',') {
                let time_str = time_part.trim();
                let filepos_str = filepos_part
                    .trim()
                    .strip_prefix("filepos:")
                    .map(|s| s.trim());

                if let Some(filepos_hex) = filepos_str {
                    // Parse timestamp HH:MM:SS:mmm
                    let parts: Vec<&str> = time_str.split(':').collect();
                    if parts.len() == 4 {
                        if let (Ok(h), Ok(m), Ok(s), Ok(ms)) = (
                            parts[0].parse::<u32>(),
                            parts[1].parse::<u32>(),
                            parts[2].parse::<u32>(),
                            parts[3].parse::<u32>(),
                        ) {
                            let timestamp_ms = h * 3600000 + m * 60000 + s * 1000 + ms;

                            // Parse file position (hex)
                            if let Ok(file_position) = u64::from_str_radix(filepos_hex, 16) {
                                result.timestamps.push(VobSubTimestamp {
                                    timestamp_ms,
                                    file_position,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_idx_basic() {
        let idx = r#"
# VobSub index file
size: 720x480
palette: 000000, ffffff, 808080, 404040, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000, 000000
id: en, index: 0
timestamp: 00:00:01:000, filepos: 00000000
timestamp: 00:00:05:500, filepos: 00001000
"#;

        let result = parse_idx(idx);

        assert_eq!(result.metadata.width, 720);
        assert_eq!(result.metadata.height, 480);
        assert_eq!(result.metadata.language, Some("en".to_string()));
        assert_eq!(result.timestamps.len(), 2);
        assert_eq!(result.timestamps[0].timestamp_ms, 1000);
        assert_eq!(result.timestamps[1].timestamp_ms, 5500);
    }
}
