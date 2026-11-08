import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import * as modernGlue from '../../pkg/libbitsub'
import * as compatGlue from '../../pkg-compat/libbitsub'

type WasmApi = typeof import('./wasm')
type Glue = typeof modernGlue

/** Import a fresh copy of ./wasm so its cached variant detection runs again. */
function importFreshWasmApi(): Promise<WasmApi> {
  return import(`./wasm.ts?fresh=${crypto.randomUUID()}`)
}

const pkgRoot = new URL('../../', import.meta.url)
const readBytes = (path: string) => readFileSync(new URL(path, pkgRoot))

describe('WASM variant selection', () => {
  test('uses the modern build when reference types and multi-value validate', async () => {
    const api = await importFreshWasmApi()

    expect(api.getWasmVariant()).toBe('modern')
    expect(api.getWasmUrl()).toEndWith('/pkg/libbitsub_bg.wasm')
    expect(api.getWasmGlueUrl()).toEndWith('/pkg/libbitsub.js')
  })

  test('falls back to the compat build when the engine rejects those features', async () => {
    const validate = spyOn(WebAssembly, 'validate').mockReturnValue(false)
    const api = await importFreshWasmApi()
    try {
      expect(api.getWasmVariant()).toBe('compat')
    } finally {
      validate.mockRestore()
    }
    expect(api.getWasmUrl()).toEndWith('/pkg-compat/libbitsub_bg.wasm')
    expect(api.getWasmGlueUrl()).toEndWith('/pkg-compat/libbitsub.js')

    await api.initWasm()
    const parser = new (api.getWasm().VobSubParser)()
    parser.loadFromData(readBytes('src/testfiles/vobsub.idx').toString('utf8'), readBytes('src/testfiles/vobsub.sub'))
    expect(parser.count).toBeGreaterThan(0)
    parser.free()
  })
})

describe('compat build parity', () => {
  function snapshot(glue: Glue, wasmPath: string) {
    glue.initSync({ module: readBytes(wasmPath) })

    const parser = new glue.VobSubParser()
    parser.loadFromData(readBytes('src/testfiles/vobsub.idx').toString('utf8'), readBytes('src/testfiles/vobsub.sub'))

    const frames = []
    for (const index of [0, Math.floor(parser.count / 2), parser.count - 1]) {
      const frame = parser.renderAtIndex(index)
      frames.push(frame ? { width: frame.width, height: frame.height, rgba: Array.from(frame.getRgba()) } : null)
      frame?.free()
    }

    const result = {
      count: parser.count,
      language: parser.language,
      trackId: parser.trackId,
      timestamps: Array.from(parser.getTimestamps()),
      frames
    }
    parser.free()
    return result
  }

  test('compat and modern builds decode identically', () => {
    const modern = snapshot(modernGlue, 'pkg/libbitsub_bg.wasm')
    const compat = snapshot(compatGlue as unknown as Glue, 'pkg-compat/libbitsub_bg.wasm')

    expect(modern.count).toBeGreaterThan(0)
    expect(modern.frames.some((frame) => frame !== null && frame.rgba.length > 0)).toBe(true)
    expect(compat).toEqual(modern)
  })
})
