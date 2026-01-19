//! Debanding filter for VobSub RGBA output.
//!
//! Implements a simplified neo_f3kdb-style algorithm to reduce banding artifacts
//! in subtitle bitmaps. Uses cross-shaped sampling with factor-based blending.

/// Configuration for the debanding filter.
#[derive(Clone, Debug)]
pub struct DebandConfig {
    /// Enable/disable debanding.
    pub enabled: bool,
    /// Primary difference threshold (0.0-255.0, default: 64.0).
    pub threshold: f32,
    /// Sample range in pixels (default: 15).
    pub range: u32,
    /// Random seed for deterministic offset generation.
    pub seed: u32,
}

impl Default for DebandConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold: 64.0,
            range: 15,
            seed: 0x1337,
        }
    }
}

/// Apply debanding filter to RGBA buffer.
///
/// Pure function: takes immutable input, returns new buffer.
pub fn apply_deband(rgba: &[u8], width: usize, height: usize, config: &DebandConfig) -> Vec<u8> {
    if !config.enabled || width == 0 || height == 0 {
        return rgba.to_vec();
    }

    let mut output = vec![0u8; rgba.len()];
    let range = config.range as i32;

    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) * 4;
            let src = read_pixel(rgba, idx);

            // Skip fully transparent pixels
            if src[3] == 0 {
                write_pixel(&mut output, idx, src);
                continue;
            }

            // Get deterministic pseudo-random offset
            let (ox, oy) = sample_offset(config.seed, x as u32, y as u32, range);

            // Sample 4 cross-shaped reference pixels
            let refs = sample_cross(rgba, width, height, x, y, ox, oy);

            // Compute blend factor and apply
            let blended = blend_deband(src, refs, config.threshold);
            write_pixel(&mut output, idx, blended);
        }
    }

    output
}

/// Read RGBA pixel at byte offset.
#[inline]
fn read_pixel(rgba: &[u8], idx: usize) -> [u8; 4] {
    [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]]
}

/// Write RGBA pixel at byte offset.
#[inline]
fn write_pixel(output: &mut [u8], idx: usize, pixel: [u8; 4]) {
    output[idx..idx + 4].copy_from_slice(&pixel);
}

/// Generate deterministic pseudo-random offset from seed and position.
fn sample_offset(seed: u32, x: u32, y: u32, range: i32) -> (i32, i32) {
    // Simple hash combining seed with position
    let hash = seed
        .wrapping_mul(0x9E3779B9)
        .wrapping_add(x.wrapping_mul(0x85EBCA6B))
        .wrapping_add(y.wrapping_mul(0xC2B2AE35));

    let ox = ((hash & 0xFFFF) as i32 % (range * 2 + 1)) - range;
    let oy = (((hash >> 16) & 0xFFFF) as i32 % (range * 2 + 1)) - range;

    (ox.max(1), oy.max(1)) // Ensure non-zero offset
}

/// Sample 4 cross-shaped reference pixels around (x, y).
/// Returns [up, down, left, right] pixels.
fn sample_cross(
    rgba: &[u8],
    width: usize,
    height: usize,
    x: usize,
    y: usize,
    ox: i32,
    oy: i32,
) -> [[u8; 4]; 4] {
    let sample_at = |dx: i32, dy: i32| -> [u8; 4] {
        let nx = (x as i32 + dx).clamp(0, width as i32 - 1) as usize;
        let ny = (y as i32 + dy).clamp(0, height as i32 - 1) as usize;
        let idx = (ny * width + nx) * 4;
        read_pixel(rgba, idx)
    };

    [
        sample_at(0, -oy), // up
        sample_at(0, oy),  // down
        sample_at(-ox, 0), // left
        sample_at(ox, 0),  // right
    ]
}

/// Compute deband blend for a single pixel using neo_f3kdb-style algorithm.
fn blend_deband(src: [u8; 4], refs: [[u8; 4]; 4], threshold: f32) -> [u8; 4] {
    let mut result = [0u8; 4];

    // Process R, G, B channels (preserve alpha)
    for c in 0..3 {
        let s = src[c] as f32;
        let r: [f32; 4] = [
            refs[0][c] as f32,
            refs[1][c] as f32,
            refs[2][c] as f32,
            refs[3][c] as f32,
        ];

        // Average of reference pixels
        let avg = (r[0] + r[1] + r[2] + r[3]) * 0.25;

        // Difference metrics
        let avg_dif = (avg - s).abs();
        let max_dif = r.iter().map(|&v| (v - s).abs()).fold(0.0f32, f32::max);
        let mid_dif_v = ((r[0] + r[1]) * 0.5 - s).abs(); // vertical midpoint
        let mid_dif_h = ((r[2] + r[3]) * 0.5 - s).abs(); // horizontal midpoint

        // Compute blend factor
        let factor = compute_factor(avg_dif, max_dif, mid_dif_v, mid_dif_h, threshold);

        // Blend: src + (avg - src) * factor
        let blended = s + (avg - s) * factor;
        result[c] = blended.clamp(0.0, 255.0) as u8;
    }

    // Preserve original alpha
    result[3] = src[3];
    result
}

/// Compute the blend factor based on difference metrics.
#[inline]
fn compute_factor(avg_dif: f32, max_dif: f32, mid_v: f32, mid_h: f32, thresh: f32) -> f32 {
    let saturate = |x: f32| x.clamp(0.0, 1.0);

    let t1 = thresh;
    let t2 = thresh * 0.75; // Secondary threshold for midpoint checks

    let f1 = saturate(3.0 * (1.0 - avg_dif / t1));
    let f2 = saturate(3.0 * (1.0 - max_dif / t1));
    let f3 = saturate(3.0 * (1.0 - mid_v / t2));
    let f4 = saturate(3.0 * (1.0 - mid_h / t2));

    // Combined factor with power adjustment for smoother blending
    (f1 * f2 * f3 * f4).powf(0.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = DebandConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.threshold, 64.0);
        assert_eq!(config.range, 15);
    }

    #[test]
    fn test_disabled_passthrough() {
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255];
        let config = DebandConfig::default(); // disabled by default
        let result = apply_deband(&rgba, 2, 1, &config);
        assert_eq!(result, rgba);
    }

    #[test]
    fn test_transparent_skip() {
        let rgba = vec![255, 0, 0, 0]; // Fully transparent
        let config = DebandConfig {
            enabled: true,
            ..Default::default()
        };
        let result = apply_deband(&rgba, 1, 1, &config);
        assert_eq!(result[3], 0); // Alpha preserved
    }

    #[test]
    fn test_sample_offset_deterministic() {
        let (ox1, oy1) = sample_offset(0x1337, 10, 20, 15);
        let (ox2, oy2) = sample_offset(0x1337, 10, 20, 15);
        assert_eq!((ox1, oy1), (ox2, oy2)); // Same inputs = same outputs
    }
}
