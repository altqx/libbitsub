import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

type RendererModule = typeof import('./renderers')

const originalWorker = globalThis.Worker
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

let renderers: RendererModule

const context2d = {
  clearRect() {},
  save() {},
  restore() {},
  putImageData() {},
  drawImage() {},
  globalAlpha: 1
}

function createVideo(): HTMLVideoElement {
  const parent = {
    style: {} as CSSStyleDeclaration,
    appendChild(canvas: { parentElement: unknown }) {
      canvas.parentElement = parent
    },
    removeChild(canvas: { parentElement: unknown }) {
      canvas.parentElement = null
    }
  }

  return {
    currentTime: 0,
    paused: true,
    ended: false,
    videoWidth: 1920,
    videoHeight: 1080,
    parentElement: parent,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 })
  } as unknown as HTMLVideoElement
}

function pgsEndDisplaySet(pts90k: number): Uint8Array {
  return new Uint8Array([
    0x50,
    0x47,
    (pts90k >>> 24) & 0xff,
    (pts90k >>> 16) & 0xff,
    (pts90k >>> 8) & 0xff,
    pts90k & 0xff,
    0,
    0,
    0,
    0,
    0x80,
    0,
    0
  ])
}

function dvbSegment(type: number, data: number[]): number[] {
  return [0x0f, type, 0, 1, (data.length >>> 8) & 0xff, data.length & 0xff, ...data]
}

function dvbClearCue(pts90k: number): Uint8Array {
  const payload = [0x20, 0, ...dvbSegment(0x10, [5, 0x10]), ...dvbSegment(0x80, []), 0xff]
  return new Uint8Array([
    0x44,
    0x56,
    (pts90k >>> 24) & 0xff,
    (pts90k >>> 16) & 0xff,
    (pts90k >>> 8) & 0xff,
    pts90k & 0xff,
    (payload.length >>> 24) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff,
    payload.length & 0xff,
    ...payload
  ])
}

beforeAll(async () => {
  Reflect.deleteProperty(globalThis, 'Worker')
  Object.assign(globalThis, {
    window: {
      devicePixelRatio: 1,
      getComputedStyle: () => ({ position: 'static' })
    },
    document: {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`)
        return {
          width: 0,
          height: 0,
          style: {},
          parentElement: null,
          getContext: (kind: string) => (kind === '2d' ? context2d : null)
        }
      }
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {}
  })

  renderers = await import('./renderers')
})

afterAll(() => {
  Object.assign(globalThis, {
    Worker: originalWorker,
    window: originalWindow,
    document: originalDocument,
    ResizeObserver: originalResizeObserver,
    requestAnimationFrame: originalRequestAnimationFrame,
    cancelAnimationFrame: originalCancelAnimationFrame
  })
})

describe('live PGS/DVB renderers', () => {
  test('queues PGS chunks immediately, flushes, resets, and remains reusable', async () => {
    const renderer = new renderers.PgsRenderer({ video: createVideo(), offscreenRender: false })
    const cue = pgsEndDisplaySet(90_000)

    expect(await renderer.append(cue.subarray(0, 7))).toBe(0)
    expect(await renderer.append(cue.subarray(7))).toBe(1)
    expect(renderer.getMetadata()?.cueCount).toBe(1)
    expect(await renderer.flush()).toBe(1)

    await renderer.reset()
    expect(renderer.getStats().totalEntries).toBe(0)
    expect(renderer.getCurrentCueMetadata()).toBeNull()
    expect(await renderer.append(cue.buffer)).toBe(1)

    renderer.dispose()
  })

  test('pushes DVB frames and clears all cue timing on reset', async () => {
    const renderer = new renderers.DvbRenderer({ video: createVideo(), offscreenRender: false })
    const cue = dvbClearCue(180_000)

    expect(await renderer.append(cue)).toBe(1)
    expect(renderer.getMetadata()?.cueCount).toBe(1)
    expect(renderer.getCueMetadata(0)?.startTime).toBe(2000)
    expect(await renderer.flush()).toBe(1)

    await renderer.reset()
    expect(renderer.getMetadata()?.cueCount).toBe(0)
    expect(renderer.getStats().totalEntries).toBe(0)

    renderer.dispose()
  })
})
