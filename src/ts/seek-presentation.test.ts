import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { WorkerRequest } from './types'

type RendererModule = typeof import('./renderers')
type WorkerModule = typeof import('./worker')
type PgsRenderer = InstanceType<RendererModule['PgsRenderer']>

const originalWorker = globalThis.Worker
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
const originalImageData = globalThis.ImageData

// Display sets at 0 s (cue), 1 s (clear), 2 s (cue) and 3 s (clear).
const STARTS = new Float64Array([0, 1000, 2000, 3000])
const EMPTY = new Set([1, 3])

let renderers: RendererModule
let workerModule: WorkerModule

const ctxCalls = { clearRect: 0, drawImage: 0 }
const context2d = {
  clearRect() {
    ctxCalls.clearRect++
  },
  save() {},
  restore() {},
  putImageData() {},
  drawImage() {
    ctxCalls.drawImage++
  },
  globalAlpha: 1
}

class FakeWorker {
  /** When set, renderPgsAtIndex responses wait for `releaseHeld()`. */
  static holdRenders = false
  static held: Array<() => void> = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor(..._args: unknown[]) {}

  postMessage(message: WorkerRequest & { _id: number }): void {
    const reply = (response: object) => this.onmessage?.({ data: { _id: message._id, ...response } } as MessageEvent)
    const metadata = { format: 'pgs', cueCount: STARTS.length, screenWidth: 1920, screenHeight: 1080 }

    switch (message.type) {
      case 'init':
        queueMicrotask(() => reply({ type: 'initComplete', success: true }))
        break
      case 'loadPgs':
        queueMicrotask(() =>
          reply({ type: 'pgsLoaded', count: STARTS.length, metadata, timestamps: new Float64Array(STARTS) })
        )
        break
      case 'renderPgsAtIndex': {
        const { index } = message as { index: number }
        const respond = () =>
          reply(
            EMPTY.has(index)
              ? { type: 'pgsFrame', frame: null, renderIssue: 'EMPTY_CUE' }
              : {
                  type: 'pgsFrame',
                  frame: {
                    width: 1920,
                    height: 1080,
                    compositions: [{ x: 10, y: 10, width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) }]
                  }
                }
          )
        if (FakeWorker.holdRenders) FakeWorker.held.push(respond)
        else queueMicrotask(respond)
        break
      }
      default:
        queueMicrotask(() => reply({ type: 'ok' }))
    }
  }

  terminate(): void {}

  static releaseHeld(): void {
    for (const respond of FakeWorker.held.splice(0)) respond()
  }
}

interface FakeVideo extends HTMLVideoElement {
  tick(mediaTime: number): void
  fire(type: string): void
}

function createVideo(): FakeVideo {
  const parent = {
    style: {} as CSSStyleDeclaration,
    appendChild(canvas: { parentElement: unknown; parentNode: unknown }) {
      canvas.parentElement = parent
      canvas.parentNode = parent
    },
    removeChild(canvas: { parentElement: unknown; parentNode: unknown }) {
      canvas.parentElement = null
      canvas.parentNode = null
    }
  }
  const listeners = new Map<string, Set<() => void>>()
  let callback: ((now: number, metadata: { mediaTime: number; presentedFrames: number }) => void) | null = null
  let presented = 0

  return {
    currentTime: 0,
    paused: true,
    ended: false,
    videoWidth: 1920,
    videoHeight: 1080,
    parentElement: parent,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    requestVideoFrameCallback(cb: typeof callback) {
      callback = cb
      return 1
    },
    cancelVideoFrameCallback() {
      callback = null
    },
    tick(mediaTime: number) {
      const pending = callback
      callback = null
      pending?.(0, { mediaTime, presentedFrames: ++presented })
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener()
    }
  } as unknown as FakeVideo
}

async function createRenderer(video: FakeVideo): Promise<PgsRenderer> {
  const renderer = new renderers.PgsRenderer({
    video,
    subContent: new ArrayBuffer(8),
    backend: 'canvas2d',
    offscreenRender: false
  })
  await (renderer as unknown as { initPromise: Promise<void> }).initPromise
  return renderer
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  Object.assign(globalThis, {
    Worker: FakeWorker,
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
          parentNode: null,
          getContext: (kind: string) => (kind === '2d' ? context2d : null)
        }
      }
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    ImageData: class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    }
  })

  workerModule = await import('./worker')
  workerModule.resetWorkerForTests()
  renderers = await import('./renderers')
})

afterAll(() => {
  workerModule.resetWorkerForTests()
  Object.assign(globalThis, {
    Worker: originalWorker,
    window: originalWindow,
    document: originalDocument,
    ResizeObserver: originalResizeObserver,
    requestAnimationFrame: originalRequestAnimationFrame,
    cancelAnimationFrame: originalCancelAnimationFrame,
    ImageData: originalImageData
  })
})

describe('video content bounds', () => {
  test('re-letterboxes when the intrinsic size changes without a loadedmetadata or element resize', async () => {
    FakeWorker.holdRenders = false
    const video = createVideo()
    const renderer = await createRenderer(video)
    const canvas = (renderer as unknown as { canvas: { style: Record<string, string> } }).canvas
    expect(canvas.style.top).toBe('0px')
    expect(canvas.style.height).toBe('1080px')

    // The next episode is 2.40:1 inside the same 16:9 fullscreen element.
    video.videoWidth = 1920
    video.videoHeight = 800
    video.fire('resize')
    expect(canvas.style.top).toBe('140px')
    expect(canvas.style.height).toBe('800px')
    renderer.dispose()
  })
})

describe('PGS seek presentation', () => {
  for (const order of ['seeked first', 'frame first'] as const) {
    test(`clears the pre-seek cue while the new position decodes (playing, ${order})`, async () => {
      FakeWorker.holdRenders = false
      FakeWorker.held = []
      const video = createVideo()
      video.paused = false
      const renderer = await createRenderer(video)

      video.tick(0.5)
      await settle()
      expect(renderer.getCurrentCueMetadata()?.index).toBe(0)

      FakeWorker.holdRenders = true
      ctxCalls.clearRect = 0
      ctxCalls.drawImage = 0
      video.currentTime = 1.5
      if (order === 'seeked first') {
        video.fire('seeked')
        video.tick(1.5)
      } else {
        video.tick(1.5)
        video.fire('seeked')
        video.tick(1.52)
      }
      expect(ctxCalls.clearRect).toBeGreaterThan(0)
      expect(ctxCalls.drawImage).toBe(0)

      FakeWorker.holdRenders = false
      FakeWorker.releaseHeld()
      await settle()
      expect(ctxCalls.drawImage).toBe(0)
      renderer.dispose()
    })
  }

  test('clears the pre-seek cue while the new position decodes (paused)', async () => {
    FakeWorker.holdRenders = false
    FakeWorker.held = []
    const video = createVideo()
    const renderer = await createRenderer(video)

    video.currentTime = 0.5
    video.fire('seeked')
    await settle()
    expect(renderer.getCurrentCueMetadata()?.index).toBe(0)

    FakeWorker.holdRenders = true
    ctxCalls.clearRect = 0
    ctxCalls.drawImage = 0
    video.currentTime = 2.5
    video.fire('seeked')
    expect(ctxCalls.clearRect).toBeGreaterThan(0)
    expect(ctxCalls.drawImage).toBe(0)

    // The new position's cue paints once it decodes.
    FakeWorker.holdRenders = false
    FakeWorker.releaseHeld()
    await settle()
    expect(ctxCalls.drawImage).toBe(1)
    expect(renderer.getCurrentCueMetadata()?.index).toBe(2)
    renderer.dispose()
  })

  test('keeps the previous cue while the next one decodes during continuous playback', async () => {
    FakeWorker.holdRenders = false
    FakeWorker.held = []
    const video = createVideo()
    video.paused = false
    const renderer = await createRenderer(video)

    video.tick(2.5)
    await settle()
    FakeWorker.holdRenders = true
    ctxCalls.clearRect = 0
    video.tick(3.01)
    expect(ctxCalls.clearRect).toBe(0)
    FakeWorker.holdRenders = false
    FakeWorker.releaseHeld()
    await settle()
    expect(ctxCalls.clearRect).toBe(1)
    renderer.dispose()
  })
})
