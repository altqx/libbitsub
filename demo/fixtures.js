const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
}

function pushU16(out, value) {
  out.push((value >> 8) & 0xff, value & 0xff)
}

function pushU24(out, value) {
  out.push((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
}

function pushU32(out, value) {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function pgsSegment(out, pts, type, payload) {
  out.push(0x50, 0x47)
  pushU32(out, pts)
  pushU32(out, 0)
  out.push(type)
  pushU16(out, payload.length)
  out.push(...payload)
}

function drawText(width, height, text, scale, color) {
  const bitmap = Array.from({ length: height }, () => new Uint8Array(width))
  const glyphWidth = 5 * scale
  const gap = scale
  const totalWidth = text.length * (glyphWidth + gap) - gap
  let x = Math.max(0, Math.floor((width - totalWidth) / 2))
  const y = Math.max(0, Math.floor((height - 7 * scale) / 2))

  for (const character of text) {
    const glyph = GLYPHS[character] ?? GLYPHS[' ']
    for (let gy = 0; gy < glyph.length; gy += 1) {
      for (let gx = 0; gx < glyph[gy].length; gx += 1) {
        if (glyph[gy][gx] !== '1') continue
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = x + gx * scale + dx
            const py = y + gy * scale + dy
            if (px >= 0 && py >= 0 && px < width && py < height) bitmap[py][px] = color
          }
        }
      }
    }
    x += glyphWidth + gap
  }

  return bitmap
}

function encodePgsRle(bitmap) {
  const out = []

  for (const row of bitmap) {
    let start = 0
    while (start < row.length) {
      const color = row[start]
      let end = start + 1
      while (end < row.length && row[end] === color) end += 1
      let remaining = end - start

      while (remaining > 0) {
        const run = Math.min(63, remaining)
        if (color === 0) {
          out.push(0x00, run)
        } else {
          out.push(0x00, 0x80 | run, color)
        }
        remaining -= run
      }

      start = end
    }
    out.push(0x00, 0x00)
  }

  return out
}

function buildPcs(width, height, objectId, x, y) {
  const payload = []
  pushU16(payload, width)
  pushU16(payload, height)
  payload.push(0x10)
  pushU16(payload, 0)
  payload.push(0x80, 0x00, 0x00, 0x01)
  pushU16(payload, objectId)
  payload.push(0x00, 0x00)
  pushU16(payload, x)
  pushU16(payload, y)
  return payload
}

function buildPds() {
  return [
    0x00,
    0x00,
    0,
    16,
    128,
    128,
    0,
    1,
    235,
    128,
    128,
    255,
    2,
    155,
    180,
    85,
    255
  ]
}

function buildOds(objectId, width, height, rle) {
  const payload = []
  pushU16(payload, objectId)
  payload.push(0x00, 0xc0)
  pushU24(payload, 4 + rle.length)
  pushU16(payload, width)
  pushU16(payload, height)
  payload.push(...rle)
  return payload
}

function pgsDisplaySet(pts, text, color) {
  const width = 512
  const height = 64
  const bitmap = drawText(width, height, text, 5, color)
  const rle = encodePgsRle(bitmap)
  const out = []
  pgsSegment(out, pts, 0x16, buildPcs(1280, 720, 1, 384, 610))
  pgsSegment(out, pts, 0x17, [0x01, 0x00, 0x01, 0x80, 0x02, 0x62, 0x02, 0x00, 0x00, 0x40])
  pgsSegment(out, pts, 0x14, buildPds())
  pgsSegment(out, pts, 0x15, buildOds(1, width, height, rle))
  pgsSegment(out, pts, 0x80, [])
  return out
}

export function buildPgsSample() {
  const out = []
  for (const [index, text] of ['PGS DEMO', 'BITMAP', 'AUTO LOAD', 'EXPORT'].entries()) {
    out.push(...pgsDisplaySet(index * 126000, text, index % 2 === 0 ? 1 : 2))
  }
  return Uint8Array.from(out)
}

function dvbSegment(type, pageId, data) {
  return [0x0f, type, (pageId >> 8) & 0xff, pageId & 0xff, (data.length >> 8) & 0xff, data.length & 0xff, ...data]
}

function encodeDvbField(bitmap, parity) {
  const out = []
  for (let y = parity; y < bitmap.length; y += 2) {
    const row = bitmap[y]
    out.push(0x12)
    let start = 0
    while (start < row.length) {
      const color = row[start]
      let end = start + 1
      while (end < row.length && row[end] === color) end += 1
      let remaining = end - start
      while (remaining > 0) {
        const run = Math.min(127, remaining)
        out.push(0x00, 0x80 | run, color)
        remaining -= run
      }
      start = end
    }
    out.push(0x00, 0x00, 0xf0)
  }
  return out
}

function dvbObject(width, height, bitmap) {
  const top = encodeDvbField(bitmap, 0)
  const bottom = encodeDvbField(bitmap, 1)
  return [0x00, 0x01, 0x00, (top.length >> 8) & 0xff, top.length & 0xff, (bottom.length >> 8) & 0xff, bottom.length & 0xff, ...top, ...bottom]
}

function encodeDvFrame(pts90k, payload) {
  const out = [0x44, 0x56, (pts90k >>> 24) & 0xff, (pts90k >>> 16) & 0xff, (pts90k >>> 8) & 0xff, pts90k & 0xff]
  pushU32(out, payload.length)
  out.push(...payload)
  return out
}

function dvbDisplaySet(pts90k, text, version) {
  const width = 360
  const height = 64
  const bitmap = drawText(width, height, text, 4, 1)
  const page = [0x03, (version << 4) | 0x08, 0x01, 0x00, 0x00, 0xe0, 0x01, 0x80]
  const region = [
    0x01,
    0x08,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
    0x0c,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00
  ]
  const clut = [0x00, version << 4, 0x01, 0x21, 0xff, 0x80, 0x80, 0x00]
  const object = dvbObject(width, height, bitmap)
  const payload = [0x20, 0x00]
  payload.push(...dvbSegment(0x10, 1, page))
  payload.push(...dvbSegment(0x11, 1, region))
  payload.push(...dvbSegment(0x12, 1, clut))
  payload.push(...dvbSegment(0x13, 1, object))
  payload.push(...dvbSegment(0x80, 1, []), 0xff)
  return encodeDvFrame(pts90k, payload)
}

export function buildDvbSample() {
  const out = []
  for (const [index, text] of ['DVB-SUB', 'LIVE PUSH', 'PAGE STATE', 'RESET OK'].entries()) {
    out.push(...dvbDisplaySet(index * 135000, text, index & 0x0f))
  }
  return Uint8Array.from(out)
}

export function buildDvbLiveChunk() {
  return Uint8Array.from(dvbDisplaySet(0, 'DVB LIVE', 0))
}
