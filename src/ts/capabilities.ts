import { isWorkerAvailable } from './worker'
import { isWebGPUSupported } from './webgpu-renderer'
import { isWebGL2Supported } from './webgl2-renderer'
import type { RuntimeCapabilities, SubtitlePresentPath } from './types'

/** Whether OffscreenCanvas exists. */
export function isOffscreenCanvasSupported(): boolean {
  return typeof OffscreenCanvas !== 'undefined'
}

/** Whether HTMLCanvasElement.transferControlToOffscreen exists. */
export function isTransferControlToOffscreenSupported(): boolean {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype === 'object' &&
    typeof (
      HTMLCanvasElement.prototype as HTMLCanvasElement & {
        transferControlToOffscreen?: unknown
      }
    ).transferControlToOffscreen === 'function'
  )
}

/** Whether OffscreenCanvas supports a 2D context. */
export function isOffscreenCanvas2DSupported(): boolean {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      return !!canvas.getContext('2d')
    } catch {
      return false
    }
  }

  return false
}

/** Whether a Canvas2D context can be created. */
export function isCanvas2DSupported(offscreenCanvas2d: boolean = isOffscreenCanvas2DSupported()): boolean {
  if (offscreenCanvas2d) return true

  if (typeof document === 'undefined') return false
  try {
    return !!document.createElement('canvas').getContext('2d')
  } catch {
    return false
  }
}

/** Whether OffscreenCanvas can be transferred to a worker. */
export function canUseWorkerOffscreenRender(): boolean {
  return (
    isWorkerAvailable() &&
    isOffscreenCanvasSupported() &&
    isTransferControlToOffscreenSupported() &&
    isOffscreenCanvas2DSupported()
  )
}

function resolvePreferredPresentPath(capabilities: Omit<RuntimeCapabilities, 'preferredPresentPath' | 'reasons'>): {
  preferredPresentPath: SubtitlePresentPath
  reasons: string[]
} {
  const reasons: string[] = []

  if (capabilities.webgpu) {
    return { preferredPresentPath: 'main-webgpu', reasons }
  }
  reasons.push('WebGPU unavailable.')

  if (capabilities.webgl2) {
    return { preferredPresentPath: 'main-webgl2', reasons }
  }
  reasons.push('WebGL2 unavailable.')

  if (capabilities.workerOffscreenRender) {
    return { preferredPresentPath: 'worker-offscreen', reasons }
  }

  if (!capabilities.worker) {
    reasons.push('Worker unavailable; parse/decode stays on the main thread when possible.')
  }
  if (!capabilities.offscreenCanvas) {
    reasons.push('OffscreenCanvas unavailable.')
  }
  if (!capabilities.transferControlToOffscreen) {
    reasons.push('transferControlToOffscreen unavailable; cannot move canvas present into a Worker.')
  }
  if (
    capabilities.worker &&
    capabilities.offscreenCanvas &&
    capabilities.transferControlToOffscreen &&
    !capabilities.offscreenCanvas2d
  ) {
    reasons.push('OffscreenCanvas 2D context unavailable; Worker presentation requires Canvas2D in the Worker.')
  }
  reasons.push(
    'Worker OffscreenCanvas present path unavailable; composition uses the transfer or main-thread Canvas2D path.'
  )

  if (capabilities.canvas2d) {
    return { preferredPresentPath: 'main-canvas2d', reasons }
  }

  reasons.push('Canvas2D unavailable.')
  if (!capabilities.createImageBitmap) {
    reasons.push('createImageBitmap unavailable (export helpers may be limited).')
  }
  reasons.push('No canvas present backend detected.')
  return { preferredPresentPath: 'main-thread', reasons }
}

/** Probe browser backends available to libbitsub. */
export function getRuntimeCapabilities(): RuntimeCapabilities {
  const worker = isWorkerAvailable()
  const offscreenCanvas = isOffscreenCanvasSupported()
  const transferControlToOffscreen = isTransferControlToOffscreenSupported()
  const offscreenCanvas2d = isOffscreenCanvas2DSupported()
  const webgpu = isWebGPUSupported()
  const webgl2 = isWebGL2Supported()
  const canvas2d = isCanvas2DSupported(offscreenCanvas2d)
  const createImageBitmap = typeof globalThis.createImageBitmap === 'function'
  const workerOffscreenRender = worker && offscreenCanvas && transferControlToOffscreen && offscreenCanvas2d

  const base = {
    worker,
    offscreenCanvas,
    transferControlToOffscreen,
    offscreenCanvas2d,
    workerOffscreenRender,
    webgpu,
    webgl2,
    canvas2d,
    createImageBitmap
  }

  const { preferredPresentPath, reasons } = resolvePreferredPresentPath(base)
  return { ...base, preferredPresentPath, reasons }
}
