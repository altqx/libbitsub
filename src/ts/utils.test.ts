import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { detectSubtitleFormat } from './utils'

function encodeVint(value: number): Uint8Array {
  for (let length = 1; length <= 4; length += 1) {
    const maxValue = (1 << (7 * length)) - 2
    if (value > maxValue) continue

    const bytes = new Uint8Array(length)
    let remaining = value

    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = remaining & 0xff
      remaining >>>= 8
    }

    bytes[0] |= 1 << (8 - length)
    return bytes
  }

  throw new Error('Value too large for test EBML vint encoder')
}

function encodeUnsigned(value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value

  do {
    bytes.unshift(remaining & 0xff)
    remaining >>>= 8
  } while (remaining > 0)

  return Uint8Array.from(bytes)
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const buffer = new Uint8Array(totalLength)
  let offset = 0

  for (const part of parts) {
    buffer.set(part, offset)
    offset += part.length
  }

  return buffer
}

function element(idBytes: number[], payload: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.from(idBytes), encodeVint(payload.length), payload)
}

function makeTrackEntry(trackType: number, codecId: string): Uint8Array {
  return element([0xae], concatBytes(element([0x83], encodeUnsigned(trackType)), element([0x86], ascii(codecId))))
}

function makeMatroskaBinary(docType: string, trackEntries: Uint8Array[], extraPayload?: Uint8Array): Uint8Array {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii(docType)))

  const tracks = element([0x16, 0x54, 0xae, 0x6b], concatBytes(...trackEntries))
  const segment = element([0x18, 0x53, 0x80, 0x67], extraPayload ? concatBytes(extraPayload, tracks) : tracks)

  return concatBytes(header, segment)
}

describe('detectSubtitleFormat Matroska VobSub probing', () => {
  test('detects the real MKS fixture as VobSub', () => {
    const fixture = readFileSync(join(import.meta.dir, '..', 'testfiles', 'vobsub.mks'))

    expect(detectSubtitleFormat({ data: fixture })).toBe('vobsub')
  })

  test('rejects Matroska files that only contain S_VOBSUB text outside track metadata', () => {
    const fakeAttachment = element([0xec], ascii('S_VOBSUB'))
    const binary = makeMatroskaBinary('matroska', [makeTrackEntry(0x01, 'V_MPEG4/ISO/AVC')], fakeAttachment)

    expect(detectSubtitleFormat({ data: binary })).toBeNull()
  })

  test('rejects WebM doctypes even if a track advertises S_VOBSUB', () => {
    const binary = makeMatroskaBinary('webm', [makeTrackEntry(0x11, 'S_VOBSUB')])

    expect(detectSubtitleFormat({ data: binary })).toBeNull()
  })
})

describe('detectSubtitleFormat DVB probing', () => {
  function encodeDvFrame(pts90k: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(10 + payload.length)
    out[0] = 0x44 // D
    out[1] = 0x56 // V
    out[2] = (pts90k >>> 24) & 0xff
    out[3] = (pts90k >>> 16) & 0xff
    out[4] = (pts90k >>> 8) & 0xff
    out[5] = pts90k & 0xff
    out[6] = (payload.length >>> 24) & 0xff
    out[7] = (payload.length >>> 16) & 0xff
    out[8] = (payload.length >>> 8) & 0xff
    out[9] = payload.length & 0xff
    out.set(payload, 10)
    return out
  }

  function makeDvbPayload(): Uint8Array {
    // PES data field + page composition + end of display set
    return Uint8Array.from([
      0x20,
      0x00,
      0x0f,
      0x10,
      0x00,
      0x01,
      0x00,
      0x02,
      0x05,
      0x10,
      0x0f,
      0x80,
      0x00,
      0x01,
      0x00,
      0x00,
      0xff
    ])
  }

  test('detects DV-framed dumps as DVB', () => {
    const framed = encodeDvFrame(90_000, makeDvbPayload())
    expect(detectSubtitleFormat({ data: framed, fileName: 'track.sub' })).toBe('dvb')
  })

  test('detects .dvb filename hint', () => {
    expect(detectSubtitleFormat({ fileName: 'track.dvb' })).toBe('dvb')
  })

  test('idx companion still forces VobSub over DVB-looking .sub', () => {
    const framed = encodeDvFrame(90_000, makeDvbPayload())
    expect(detectSubtitleFormat({ data: framed, fileName: 'track.sub', idxUrl: 'track.idx' })).toBe('vobsub')
  })

  test('bare .sub without bytes still defaults to VobSub', () => {
    expect(detectSubtitleFormat({ fileName: 'track.sub' })).toBe('vobsub')
  })
})
