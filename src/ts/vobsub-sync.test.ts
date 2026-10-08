import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { WorkerRequest } from './types'

type RendererModule = typeof import('./renderers')
type WorkerModule = typeof import('./worker')
type VobSubRenderer = InstanceType<RendererModule['VobSubRenderer']>

const originalWorker = globalThis.Worker
const originalWindow = globalThis.window
const originalDocument = globalThis.document
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
const originalImageData = globalThis.ImageData

// Cues at 0 s, 1.2 s and 2.4 s. Cue 0 ends explicitly at 1.0 s; the others run to the next start.
const STARTS = new Float64Array([0, 1200, 2400])
const ENDS = new Float64Array([1000, 2400, 3400])

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
  static requests: WorkerRequest[] = []
  /** When set, renderVobSubAtIndex responses wait for `release()`. */
  static holdRenders = false
  static held: Array<() => void> = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor(..._args: unknown[]) {}

  postMessage(message: WorkerRequest & { _id: number }): void {
    FakeWorker.requests.push(message)
    const reply = (response: object) => this.onmessage?.({ data: { _id: message._id, ...response } } as MessageEvent)
    const metadata = {
      format: 'vobsub',
      cueCount: STARTS.length,
      screenWidth: 720,
      screenHeight: 480,
      language: 'en',
      trackId: 'en',
      hasIdxMetadata: true
    }

    switch (message.type) {
      case 'init':
        queueMicrotask(() => reply({ type: 'initComplete', success: true }))
        break
      case 'loadVobSub':
        queueMicrotask(() =>
          reply({ type: 'vobSubLoaded', count: STARTS.length, metadata, timestamps: new Float64Array(STARTS) })
        )
        break
      case 'getVobSubTimestamps':
        queueMicrotask(() =>
          reply({
            type: 'vobSubTimestamps',
            timestamps: new Float64Array(STARTS),
            endTimestamps: new Float64Array(ENDS)
          })
        )
        break
      case 'renderVobSubAtIndex': {
        const respond = () =>
          reply({
            type: 'vobSubFrame',
            frame: {
              width: 720,
              height: 480,
              compositions: [{ x: 10, y: 10, width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) }]
            }
          })
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
  let callback: ((now: number, metadata: { mediaTime: number; presentedFrames: number }) => void) | null = null
  let presented = 0

  return {
    currentTime: 0,
    paused: true,
    ended: false,
    videoWidth: 1920,
    videoHeight: 1080,
    parentElement: parent,
    addEventListener() {},
    removeEventListener() {},
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
    }
  } as unknown as FakeVideo
}

async function createRenderer(video: FakeVideo): Promise<VobSubRenderer> {
  const renderer = new renderers.VobSubRenderer({
    video,
    idxContent: 'id: en, index: 0',
    subContent: new ArrayBuffer(8),
    backend: 'canvas2d',
    offscreenRender: false
  })
  await (renderer as unknown as { initPromise: Promise<void> }).initPromise
  return renderer
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const indexRequests = () => FakeWorker.requests.filter((request) => request.type === 'findVobSubIndex')

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

describe('VobSub synchronous cue lookup', () => {
  test('selects the new cue on the tick that crosses its start, with no async index request', async () => {
    FakeWorker.requests = []
    FakeWorker.holdRenders = false
    const video = createVideo()
    video.paused = false
    const renderer = await createRenderer(video)

    video.tick(1.19)
    expect(renderer.getCurrentCueMetadata()?.index).toBeUndefined()
    video.tick(1.2 + 0.001)
    expect(renderer.getCurrentCueMetadata()?.index).toBe(1)

    await settle()
    expect(indexRequests()).toHaveLength(0)
    renderer.dispose()
  })

  test('clears the canvas when the previous cue ends, including while the next bitmap is pending', async () => {
    FakeWorker.requests = []
    FakeWorker.holdRenders = false
    const video = createVideo()
    video.paused = false
    const renderer = await createRenderer(video)

    video.tick(0.5)
    await settle()
    expect(ctxCalls.drawImage).toBeGreaterThan(0)

    // Gap between cue 0's end (1.0 s) and cue 1's start (1.2 s).
    ctxCalls.drawImage = 0
    ctxCalls.clearRect = 0
    video.tick(1.1)
    expect(ctxCalls.clearRect).toBe(1)
    expect(ctxCalls.drawImage).toBe(0)

    // Show cue 0 again, then cross into cue 1 while its bitmap is still decoding.
    video.tick(0.5)
    await settle()
    FakeWorker.holdRenders = true
    ctxCalls.drawImage = 0
    ctxCalls.clearRect = 0
    video.tick(1.25)
    expect(ctxCalls.clearRect).toBe(1)
    expect(ctxCalls.drawImage).toBe(0)

    // The replacement is painted immediately once it is ready, without waiting for another tick.
    FakeWorker.holdRenders = false
    FakeWorker.releaseHeld()
    await settle()
    expect(ctxCalls.drawImage).toBe(1)
    renderer.dispose()
  })

  test('paints a pending cue as soon as its bitmap arrives within the cue window, while playing', async () => {
    FakeWorker.holdRenders = true
    FakeWorker.held = []
    const video = createVideo()
    video.paused = false
    const renderer = await createRenderer(video)

    video.tick(1.3)
    ctxCalls.drawImage = 0
    FakeWorker.holdRenders = false
    FakeWorker.releaseHeld()
    await settle()
    expect(ctxCalls.drawImage).toBe(1)
    renderer.dispose()
  })
})

describe('renderAtMediaTime', () => {
  test('paints the cached cue for that time synchronously while the video is playing', async () => {
    FakeWorker.holdRenders = false
    const video = createVideo()
    video.paused = false
    const renderer = await createRenderer(video)

    // Warm the cache for cue 1, then show cue 0.
    video.tick(1.3)
    await settle()
    video.tick(0.5)
    await settle()

    ctxCalls.drawImage = 0
    renderer.timeOffset = 1 // a host commits a new offset inside its own frame callback
    expect(ctxCalls.drawImage).toBe(0) // the setter alone cannot repaint while playing
    renderer.renderAtMediaTime(0.3) // 0.3 + 1 = 1.3 s -> cue 1, cached
    expect(ctxCalls.drawImage).toBe(1)
    expect(renderer.getCurrentCueMetadata()?.index).toBe(1)
    renderer.dispose()
  })
})
