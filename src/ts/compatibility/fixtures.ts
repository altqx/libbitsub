/**
 * Synthetic compatibility fixtures for PGS / VobSub / MKS edge cases.
 * Mirrors the Rust compatibility suite builders so TS tests can exercise
 * the same malformed, palette, RLE, and display-size cases.
 */

export type PaletteEntry = {
  id: number
  y: number
  cr: number
  cb: number
  a: number
}

function pushBeU16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff)
}

function pushBeU24(out: number[], value: number): void {
  out.push((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
}

function pushBeU32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function writePgsSegment(out: number[], pts: number, segmentType: number, payload: number[]): void {
  pushBeU16(out, 0x5047)
  pushBeU32(out, pts)
  pushBeU32(out, 0)
  out.push(segmentType)
  pushBeU16(out, payload.length)
  out.push(...payload)
}

export function encodePgsSolidRle(width: number, height: number, color: number): Uint8Array {
  const data: number[] = []
  for (let y = 0; y < height; y += 1) {
    let remaining = width
    while (remaining > 0) {
      const run = Math.min(63, remaining)
      if (color === 0) {
        data.push(0x00, run)
      } else {
        data.push(0x00, 0x80 | run, color)
      }
      remaining -= run
    }
    data.push(0x00, 0x00)
  }
  return Uint8Array.from(data)
}

/** Explicit zero-length color run followed by a literal — must not hang. */
export function encodePgsZeroLengthColorRunFixture(): Uint8Array {
  return Uint8Array.from([0x00, 0x80, 0x07, 0x01])
}

/** Explicit zero-length extended transparent run followed by a literal. */
export function encodePgsZeroLengthTransparentRunFixture(): Uint8Array {
  return Uint8Array.from([0x00, 0x40, 0x00, 0x03])
}

function buildPcs(
  width: number,
  height: number,
  objectId: number,
  x: number,
  y: number
): number[] {
  const pcs: number[] = []
  pushBeU16(pcs, width)
  pushBeU16(pcs, height)
  pcs.push(0x10)
  pushBeU16(pcs, 0)
  pcs.push(0x80, 0x00, 0x00, 0x01)
  pushBeU16(pcs, objectId)
  pcs.push(0x00, 0x00)
  pushBeU16(pcs, x)
  pushBeU16(pcs, y)
  return pcs
}

function buildWds(x: number, y: number, width: number, height: number): number[] {
  const wds: number[] = [0x01, 0x00]
  pushBeU16(wds, x)
  pushBeU16(wds, y)
  pushBeU16(wds, width)
  pushBeU16(wds, height)
  return wds
}

function buildPds(entries: PaletteEntry[]): number[] {
  const pds: number[] = [0x00, 0x00]
  for (const entry of entries) {
    pds.push(entry.id, entry.y, entry.cr, entry.cb, entry.a)
  }
  return pds
}

function buildOds(objectId: number, width: number, height: number, rle: Uint8Array): number[] {
  const ods: number[] = []
  pushBeU16(ods, objectId)
  ods.push(0x00, 0xc0)
  pushBeU24(ods, 4 + rle.length)
  pushBeU16(ods, width)
  pushBeU16(ods, height)
  ods.push(...rle)
  return ods
}

export function defaultWhiteOnBlackPalette(): PaletteEntry[] {
  return [
    { id: 0, y: 16, cr: 128, cb: 128, a: 0 },
    { id: 1, y: 235, cr: 128, cb: 128, a: 255 },
    { id: 255, y: 81, cr: 90, cb: 240, a: 255 }
  ]
}

export function buildPgsSup(options: {
  pts?: number
  screenWidth: number
  screenHeight: number
  objectWidth: number
  objectHeight: number
  objectX?: number
  objectY?: number
  colorIndex?: number
  palette?: PaletteEntry[]
}): Uint8Array {
  const pts = options.pts ?? 90_000
  const objectX = options.objectX ?? 0
  const objectY = options.objectY ?? 0
  const colorIndex = options.colorIndex ?? 1
  const palette = options.palette ?? defaultWhiteOnBlackPalette()
  const rle = encodePgsSolidRle(options.objectWidth, options.objectHeight, colorIndex)

  const out: number[] = []
  writePgsSegment(out, pts, 0x16, buildPcs(options.screenWidth, options.screenHeight, 1, objectX, objectY))
  writePgsSegment(out, pts, 0x17, buildWds(objectX, objectY, options.objectWidth, options.objectHeight))
  writePgsSegment(out, pts, 0x14, buildPds(palette))
  writePgsSegment(out, pts, 0x15, buildOds(1, options.objectWidth, options.objectHeight, rle))
  writePgsSegment(out, pts, 0x80, [])
  return Uint8Array.from(out)
}

export function buildMalformedPgsBadMagic(): Uint8Array {
  return new TextEncoder().encode('NOT_A_PGS_FILE')
}

export function buildMalformedPgsTruncated(): Uint8Array {
  const full = buildPgsSup({
    screenWidth: 720,
    screenHeight: 480,
    objectWidth: 8,
    objectHeight: 4
  })
  return full.subarray(0, Math.floor(full.length / 2))
}

export function buildMalformedPgsOdsLengthMismatch(): Uint8Array {
  const pts = 90_000
  const out: number[] = []
  writePgsSegment(out, pts, 0x16, buildPcs(720, 480, 1, 0, 0))
  writePgsSegment(out, pts, 0x17, buildWds(0, 0, 8, 4))
  writePgsSegment(out, pts, 0x14, buildPds(defaultWhiteOnBlackPalette()))

  const ods: number[] = []
  pushBeU16(ods, 1)
  ods.push(0x00, 0xc0)
  pushBeU24(ods, 1_000_000)
  pushBeU16(ods, 8)
  pushBeU16(ods, 4)
  ods.push(0x01, 0x00, 0x00)
  writePgsSegment(out, pts, 0x15, ods)
  writePgsSegment(out, pts, 0x80, [])
  return Uint8Array.from(out)
}

export function buildIdx(options: {
  width: number
  height: number
  paletteHex?: string[]
  timestampMs?: number
  filePos?: number
}): string {
  const palette = (options.paletteHex ?? ['000000', 'ffffff', '808080', '404040']).join(', ')
  const timestampMs = options.timestampMs ?? 0
  const filePos = options.filePos ?? 0
  const hours = Math.floor(timestampMs / 3_600_000)
  const minutes = Math.floor(timestampMs / 60_000) % 60
  const seconds = Math.floor(timestampMs / 1000) % 60
  const millis = timestampMs % 1000
  const ts = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(millis).padStart(3, '0')}`
  return [
    '# VobSub index file, v7 (compatibility fixture)',
    `size: ${options.width}x${options.height}`,
    `palette: ${palette}`,
    `timestamp: ${ts}, filepos: ${filePos.toString(16).padStart(9, '0')}`,
    ''
  ].join('\n')
}

export function buildMalformedIdxMissingPalette(): string {
  return 'size: 720x480\ntimestamp: 00:00:01:000, filepos: 000000000\n'
}

function encodeEbmlVint(value: number): number[] {
  for (let width = 1; width <= 8; width += 1) {
    const maxValue = width === 8 ? Number.MAX_SAFE_INTEGER : (1 << (7 * width)) - 2
    if (value > maxValue) continue
    const bytes = new Array<number>(width).fill(0)
    let temp = value
    for (let index = width - 1; index >= 0; index -= 1) {
      bytes[index] = temp & 0xff
      temp >>>= 8
    }
    bytes[0] |= 1 << (8 - width)
    return bytes
  }
  throw new Error('value too large for EBML vint')
}

function encodeElementId(id: number): number[] {
  if (id > 0x00ffffff) {
    return [(id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]
  }
  if (id > 0x0000ffff) {
    return [(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]
  }
  if (id > 0x000000ff) {
    return [(id >>> 8) & 0xff, id & 0xff]
  }
  return [id & 0xff]
}

function ebmlElement(id: number, payload: number[] | Uint8Array): Uint8Array {
  const body = payload instanceof Uint8Array ? Array.from(payload) : payload
  return Uint8Array.from([...encodeElementId(id), ...encodeEbmlVint(body.length), ...body])
}

export function buildMksWithTrack(options: {
  codecId: string
  codecPrivate?: string
  language?: string
  trackType?: number
  payload?: Uint8Array
}): Uint8Array {
  const trackType = options.trackType ?? 0x11
  const language = options.language ?? 'eng'
  const codecPrivate = options.codecPrivate ?? ''

  const ebmlHeader = ebmlElement(0x1a45dfa3, ebmlElement(0x4282, new TextEncoder().encode('matroska')))
  const info = ebmlElement(0x1549a966, ebmlElement(0x2ad7b1, [0x0f, 0x42, 0x40]))

  const trackChildren: number[] = []
  trackChildren.push(...ebmlElement(0xd7, [0x01]))
  trackChildren.push(...ebmlElement(0x83, [trackType]))
  trackChildren.push(...ebmlElement(0x86, new TextEncoder().encode(options.codecId)))
  if (codecPrivate) {
    trackChildren.push(...ebmlElement(0x63a2, new TextEncoder().encode(codecPrivate)))
  }
  trackChildren.push(...ebmlElement(0x22b59c, new TextEncoder().encode(language)))
  const tracks = ebmlElement(0x1654ae6b, ebmlElement(0xae, trackChildren))

  const segmentParts: number[] = [...info, ...tracks]
  if (options.payload) {
    const simpleBlock = [0x81, 0x00, 0x00, 0x80, ...options.payload]
    const cluster = ebmlElement(0x1f43b675, [...ebmlElement(0xe7, [0x00]), ...ebmlElement(0xa3, simpleBlock)])
    segmentParts.push(...cluster)
  }

  const segment = ebmlElement(0x18538067, segmentParts)
  return Uint8Array.from([...ebmlHeader, ...segment])
}

export function buildMalformedMksNoVobSub(): Uint8Array {
  return buildMksWithTrack({ codecId: 'S_TEXT/UTF8' })
}

export function buildMalformedMksEmptyPayload(): Uint8Array {
  return buildMksWithTrack({
    codecId: 'S_VOBSUB',
    codecPrivate: 'size: 720x480\npalette: 000000, ffffff, 808080, 404040\n',
    payload: new Uint8Array(0)
  })
}

/** Alternate presentation sizes used by the display-size matrix. */
export const ALTERNATE_DISPLAY_SIZES = [
  { width: 720, height: 480 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 }
] as const

/**
 * Software golden frame: solid opaque red rectangle in a transparent screen.
 * Used by Canvas2D / WebGL2 / WebGPU pixel parity tests.
 */
export function buildSolidCompositionFixture(options?: {
  screenWidth?: number
  screenHeight?: number
  width?: number
  height?: number
  x?: number
  y?: number
  rgba?: [number, number, number, number]
}): {
  width: number
  height: number
  compositionData: Array<{
    pixelData: { data: Uint8ClampedArray; width: number; height: number }
    x: number
    y: number
  }>
} {
  const screenWidth = options?.screenWidth ?? 64
  const screenHeight = options?.screenHeight ?? 32
  const width = options?.width ?? 16
  const height = options?.height ?? 8
  const x = options?.x ?? 8
  const y = options?.y ?? 4
  const rgba = options?.rgba ?? ([255, 0, 0, 255] as [number, number, number, number])

  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]
    data[i + 1] = rgba[1]
    data[i + 2] = rgba[2]
    data[i + 3] = rgba[3]
  }

  return {
    width: screenWidth,
    height: screenHeight,
    compositionData: [
      {
        pixelData: { data, width, height },
        x,
        y
      }
    ]
  }
}
