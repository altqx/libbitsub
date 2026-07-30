/**
 * Pixel comparison helpers for visual-regression / golden-image tests.
 */

export type RgbaPixels = {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export type PixelDiffStats = {
  maxChannelDelta: number
  meanChannelDelta: number
  mismatchedPixels: number
  totalPixels: number
}

export function createImageData(width: number, height: number, fill?: [number, number, number, number]): ImageData {
  const image = new ImageData(width, height)
  if (fill) {
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = fill[0]
      image.data[i + 1] = fill[1]
      image.data[i + 2] = fill[2]
      image.data[i + 3] = fill[3]
    }
  }
  return image
}

export function fingerprintRgba(data: ArrayLike<number>): string {
  // FNV-1a 32-bit — stable across runtimes, easy to embed in goldens.
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i]!
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function diffPixels(actual: RgbaPixels, expected: RgbaPixels): PixelDiffStats {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `size mismatch: actual ${actual.width}x${actual.height} vs expected ${expected.width}x${expected.height}`
    )
  }

  const totalPixels = actual.width * actual.height
  let maxChannelDelta = 0
  let sumChannelDelta = 0
  let mismatchedPixels = 0

  for (let i = 0; i < totalPixels * 4; i += 4) {
    let pixelDelta = 0
    for (let c = 0; c < 4; c += 1) {
      const delta = Math.abs(actual.data[i + c]! - expected.data[i + c]!)
      maxChannelDelta = Math.max(maxChannelDelta, delta)
      sumChannelDelta += delta
      pixelDelta = Math.max(pixelDelta, delta)
    }
    if (pixelDelta > 0) mismatchedPixels += 1
  }

  return {
    maxChannelDelta,
    meanChannelDelta: totalPixels === 0 ? 0 : sumChannelDelta / (totalPixels * 4),
    mismatchedPixels,
    totalPixels
  }
}

/**
 * Compare two RGBA buffers with a per-channel tolerance.
 * GPU backends may introduce 1-level rounding differences after premultiply.
 */
export function assertPixelsMatch(
  actual: RgbaPixels,
  expected: RgbaPixels,
  options: { maxChannelDelta?: number; label?: string } = {}
): void {
  const maxAllowed = options.maxChannelDelta ?? 0
  const stats = diffPixels(actual, expected)
  if (stats.maxChannelDelta > maxAllowed) {
    const label = options.label ? `${options.label}: ` : ''
    throw new Error(
      `${label}pixel mismatch maxDelta=${stats.maxChannelDelta} (allowed ${maxAllowed}), ` +
        `mismatched=${stats.mismatchedPixels}/${stats.totalPixels}, mean=${stats.meanChannelDelta.toFixed(3)}`
    )
  }
}

/** Sample a single pixel (x,y) as [r,g,b,a]. */
export function samplePixel(pixels: RgbaPixels, x: number, y: number): [number, number, number, number] {
  const index = (y * pixels.width + x) * 4
  return [
    pixels.data[index]!,
    pixels.data[index + 1]!,
    pixels.data[index + 2]!,
    pixels.data[index + 3]!
  ]
}
