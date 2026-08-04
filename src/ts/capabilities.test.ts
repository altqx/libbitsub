import { expect, test } from 'bun:test'

import {
  canUseWorkerOffscreenRender,
  getRuntimeCapabilities,
  isCanvas2DSupported,
  isOffscreenCanvasSupported,
  isTransferControlToOffscreenSupported
} from './capabilities'

test('getRuntimeCapabilities reports a coherent present-path snapshot', () => {
  const caps = getRuntimeCapabilities()

  expect(typeof caps.worker).toBe('boolean')
  expect(typeof caps.offscreenCanvas).toBe('boolean')
  expect(typeof caps.transferControlToOffscreen).toBe('boolean')
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

test('workerOffscreenRender requires worker + OffscreenCanvas + transferControlToOffscreen', () => {
  const expected =
    typeof Worker !== 'undefined' &&
    typeof window !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    isOffscreenCanvasSupported() &&
    isTransferControlToOffscreenSupported() &&
    isCanvas2DSupported()

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
