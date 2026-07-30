import { describe, expect, test } from 'bun:test'

import {
  ALTERNATE_DISPLAY_SIZES,
  buildIdx,
  buildMalformedIdxMissingPalette,
  buildMalformedMksEmptyPayload,
  buildMalformedMksNoVobSub,
  buildMalformedPgsBadMagic,
  buildMalformedPgsOdsLengthMismatch,
  buildMalformedPgsTruncated,
  buildPgsSup,
  encodePgsZeroLengthColorRunFixture,
  encodePgsZeroLengthTransparentRunFixture
} from './fixtures'

describe('compatibility fixtures', () => {
  test('builds valid PGS magic headers', () => {
    const sup = buildPgsSup({
      screenWidth: 1920,
      screenHeight: 1080,
      objectWidth: 8,
      objectHeight: 4,
      objectX: 16,
      objectY: 32
    })
    expect(sup[0]).toBe(0x50)
    expect(sup[1]).toBe(0x47)
    expect(sup.byteLength).toBeGreaterThan(40)
  })

  test('covers alternate display sizes', () => {
    for (const size of ALTERNATE_DISPLAY_SIZES) {
      const sup = buildPgsSup({
        screenWidth: size.width,
        screenHeight: size.height,
        objectWidth: 4,
        objectHeight: 2
      })
      // PCS width/height sit after PG header (2) + pts(4) + dts(4) + type(1) + size(2) = 13
      const width = (sup[13]! << 8) | sup[14]!
      const height = (sup[15]! << 8) | sup[16]!
      expect(width).toBe(size.width)
      expect(height).toBe(size.height)
    }
  })

  test('malformed PGS fixtures are recognizably broken', () => {
    expect(buildMalformedPgsBadMagic()[0]).not.toBe(0x50)
    expect(buildMalformedPgsTruncated().byteLength).toBeLessThan(
      buildPgsSup({ screenWidth: 720, screenHeight: 480, objectWidth: 8, objectHeight: 4 }).byteLength
    )
    expect(buildMalformedPgsOdsLengthMismatch()[0]).toBe(0x50)
  })

  test('zero-length RLE fixtures encode count zero control codes', () => {
    const colorRun = encodePgsZeroLengthColorRunFixture()
    expect(Array.from(colorRun.slice(0, 3))).toEqual([0x00, 0x80, 0x07])
    const transparentRun = encodePgsZeroLengthTransparentRunFixture()
    expect(Array.from(transparentRun.slice(0, 3))).toEqual([0x00, 0x40, 0x00])
  })

  test('idx fixtures include size and timestamp lines', () => {
    const idx = buildIdx({ width: 1280, height: 720, timestampMs: 1500 })
    expect(idx).toContain('size: 1280x720')
    expect(idx).toContain('timestamp: 00:00:01:500')
    expect(buildMalformedIdxMissingPalette()).not.toContain('palette:')
  })

  test('malformed MKS fixtures are non-empty containers', () => {
    expect(buildMalformedMksNoVobSub().byteLength).toBeGreaterThan(32)
    expect(buildMalformedMksEmptyPayload().byteLength).toBeGreaterThan(32)
  })
})
