import { describe, expect, test } from 'bun:test'

import { ensureImageDataPolyfill } from './imagedata-polyfill'
import { buildSolidCompositionFixture } from './fixtures'
import { renderSoftwareGolden } from './backends'
import { assertPixelsMatch, fingerprintRgba, samplePixel } from './pixels'
import type { SubtitleData } from '../types'

ensureImageDataPolyfill()

function asSubtitleData(fixture: ReturnType<typeof buildSolidCompositionFixture>): SubtitleData {
  return {
    width: fixture.width,
    height: fixture.height,
    compositionData: fixture.compositionData.map((comp) => ({
      x: comp.x,
      y: comp.y,
      pixelData: new ImageData(comp.pixelData.data, comp.pixelData.width, comp.pixelData.height)
    }))
  }
}

describe('pixel-level golden images (software / Canvas2D path)', () => {
  test('solid red composition matches golden fingerprint and samples', () => {
    const frame = asSubtitleData(
      buildSolidCompositionFixture({
        screenWidth: 32,
        screenHeight: 16,
        width: 8,
        height: 4,
        x: 4,
        y: 2,
        rgba: [255, 0, 0, 255]
      })
    )

    const { pixels } = renderSoftwareGolden(frame)
    expect(pixels.width).toBe(32)
    expect(pixels.height).toBe(16)

    // Outside the composition must stay transparent.
    expect(samplePixel(pixels, 0, 0)).toEqual([0, 0, 0, 0])
    // Inside the composition must be opaque red.
    expect(samplePixel(pixels, 4, 2)).toEqual([255, 0, 0, 255])
    expect(samplePixel(pixels, 11, 5)).toEqual([255, 0, 0, 255])

    // Durable golden fingerprint for this synthetic fixture.
    expect(fingerprintRgba(pixels.data)).toBe('35408985')
  })

  test('semi-transparent composition blends predictably', () => {
    const frame = asSubtitleData(
      buildSolidCompositionFixture({
        screenWidth: 8,
        screenHeight: 4,
        width: 8,
        height: 4,
        x: 0,
        y: 0,
        rgba: [0, 0, 255, 128]
      })
    )

    const first = renderSoftwareGolden(frame).pixels
    const second = renderSoftwareGolden(frame).pixels
    assertPixelsMatch(first, second, { label: 'software deterministic' })
    expect(samplePixel(first, 0, 0)[2]).toBe(255)
    expect(samplePixel(first, 0, 0)[3]).toBe(128)
  })

  test('empty composition yields fully transparent screen crop', () => {
    const frame: SubtitleData = {
      width: 16,
      height: 8,
      compositionData: []
    }
    const { pixels } = renderSoftwareGolden(frame)
    expect(pixels.width).toBe(16)
    expect(pixels.height).toBe(8)
    for (let i = 0; i < pixels.data.length; i += 1) {
      expect(pixels.data[i]).toBe(0)
    }
  })
})
