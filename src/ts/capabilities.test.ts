import { expect, test } from 'bun:test'

import {
  canUseWorkerOffscreenRender,
  getRuntimeCapabilities,
  isCanvas2DSupported,
  isOffscreenCanvas2DSupported,
  isOffscreenCanvasSupported,
  isTransferControlToOffscreenSupported
} from './capabilities'
import { isWorkerAvailable } from './worker'

test('getRuntimeCapabilities reports a coherent present-path snapshot', () => {
  const caps = getRuntimeCapabilities()

  expect(typeof caps.worker).toBe('boolean')
  expect(typeof caps.offscreenCanvas).toBe('boolean')
  expect(typeof caps.transferControlToOffscreen).toBe('boolean')
  expect(typeof caps.offscreenCanvas2d).toBe('boolean')
  expect(typeof caps.workerOffscreenRender).toBe('boolean')
  expect(typeof caps.webgpu).toBe('boolean')
  expect(typeof caps.webgl2).toBe('boolean')
  expect(typeof caps.canvas2d).toBe('boolean')
  expect(typeof caps.createImageBitmap).toBe('boolean')
  expect(['main-webgpu', 'main-webgl2', 'worker-offscreen', 'main-canvas2d', 'main-thread']).toContain(
    caps.preferredPresentPath
  )
  expect(Array.isArray(caps.reasons)).toBe(true)
})

test('workerOffscreenRender requires worker + OffscreenCanvas + transferControlToOffscreen + OffscreenCanvas 2D', () => {
  const expected =
    isWorkerAvailable() &&
    isOffscreenCanvasSupported() &&
    isTransferControlToOffscreenSupported() &&
    isOffscreenCanvas2DSupported()

  expect(canUseWorkerOffscreenRender()).toBe(expected)
  expect(getRuntimeCapabilities().workerOffscreenRender).toBe(expected)
})

test('reasons only explain blocked better present paths', () => {
  const caps = getRuntimeCapabilities()

  if (caps.preferredPresentPath === 'main-webgpu') {
    expect(caps.reasons).toEqual([])
    return
  }

  expect(caps.reasons.length).toBeGreaterThan(0)
  expect(caps.reasons[0]).toBe('WebGPU unavailable.')

  if (caps.preferredPresentPath === 'main-canvas2d' || caps.preferredPresentPath === 'main-thread') {
    expect(caps.reasons.some((reason) => /OffscreenCanvas|transferControlToOffscreen|Worker/i.test(reason))).toBe(true)
  }
})

test('Canvas2D detection falls back to an HTML canvas when OffscreenCanvas lacks 2D', () => {
  const offscreenDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: class {
      getContext(): null {
        return null
      }
    }
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({ getContext: () => ({}) })
    }
  })

  try {
    expect(isCanvas2DSupported()).toBe(true)
  } finally {
    if (offscreenDescriptor) {
      Object.defineProperty(globalThis, 'OffscreenCanvas', offscreenDescriptor)
    } else {
      delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas
    }
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor)
    } else {
      delete (globalThis as { document?: unknown }).document
    }
  }
})

test('getRuntimeCapabilities probes OffscreenCanvas 2D only once', () => {
  const offscreenDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')
  let constructorCalls = 0

  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: class {
      constructor() {
        constructorCalls++
      }

      getContext(): object {
        return {}
      }
    }
  })

  try {
    getRuntimeCapabilities()
    expect(constructorCalls).toBe(1)
  } finally {
    if (offscreenDescriptor) {
      Object.defineProperty(globalThis, 'OffscreenCanvas', offscreenDescriptor)
    } else {
      delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas
    }
  }
})

test('reports a dedicated reason when Worker OffscreenCanvas lacks a 2D context', () => {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const offscreenDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')
  const htmlCanvasDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement')

  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class {} })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: class {
      getContext(): null {
        return null
      }
    }
  })
  class MockHtmlCanvasElement {}
  Object.defineProperty(MockHtmlCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => ({})
  })
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { configurable: true, value: MockHtmlCanvasElement })

  try {
    const caps = getRuntimeCapabilities()
    expect(caps.offscreenCanvas2d).toBe(false)
    expect(caps.workerOffscreenRender).toBe(false)
    if (!caps.webgpu && !caps.webgl2) {
      expect(caps.reasons).toContain(
        'OffscreenCanvas 2D context unavailable; Worker presentation requires Canvas2D in the Worker.'
      )
    }
  } finally {
    for (const [name, descriptor] of [
      ['Worker', workerDescriptor],
      ['window', windowDescriptor],
      ['OffscreenCanvas', offscreenDescriptor],
      ['HTMLCanvasElement', htmlCanvasDescriptor]
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    }
  }
})
