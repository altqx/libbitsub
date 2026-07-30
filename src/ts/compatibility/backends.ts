/**
 * Backend render + pixel-readback helpers for visual regression.
 * Supports Canvas2D, WebGL2, and WebGPU when the environment provides them.
 */

import type { SubtitleCompositionData, SubtitleData } from '../types'
import { WebGL2Renderer, isWebGL2Supported } from '../webgl2-renderer'
import { WebGPURenderer, isWebGPUSupported } from '../webgpu-renderer'
import { renderFrameData } from '../frame-export'
import type { RgbaPixels } from './pixels'

export type VisualBackendName = 'software' | 'canvas2d' | 'webgl2' | 'webgpu'

export interface BackendRenderResult {
  backend: VisualBackendName
  pixels: RgbaPixels
  skipped?: string
}

function toCompositionData(frame: SubtitleData): SubtitleCompositionData[] {
  return frame.compositionData.map((comp) => {
    if (comp.pixelData instanceof ImageData) {
      return comp
    }
    return {
      ...comp,
      pixelData: new ImageData(
        comp.pixelData.data instanceof Uint8ClampedArray
          ? comp.pixelData.data
          : new Uint8ClampedArray(comp.pixelData.data),
        comp.pixelData.width,
        comp.pixelData.height
      )
    }
  })
}

/** Software compositor golden path (matches frame-export / Canvas2D putImageData). */
export function renderSoftwareGolden(frame: SubtitleData): BackendRenderResult {
  const rendered = renderFrameData(frame, { crop: 'screen' })
  if (!rendered) {
    return {
      backend: 'software',
      pixels: { data: new Uint8ClampedArray(4), width: 1, height: 1 }
    }
  }
  return {
    backend: 'software',
    pixels: {
      data: rendered.imageData.data,
      width: rendered.imageData.width,
      height: rendered.imageData.height
    }
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  throw new Error('No canvas implementation available')
}

export function renderCanvas2D(frame: SubtitleData): BackendRenderResult {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    return {
      backend: 'canvas2d',
      pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
      skipped: 'Canvas2D unavailable in this runtime'
    }
  }

  const compositions = toCompositionData(frame)
  const canvas = createCanvas(frame.width, frame.height)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) {
    return {
      backend: 'canvas2d',
      pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
      skipped: 'Could not acquire 2D context'
    }
  }

  ctx.clearRect(0, 0, frame.width, frame.height)
  for (const comp of compositions) {
    ctx.putImageData(comp.pixelData, comp.x, comp.y)
  }

  const imageData = ctx.getImageData(0, 0, frame.width, frame.height)
  return {
    backend: 'canvas2d',
    pixels: { data: imageData.data, width: imageData.width, height: imageData.height }
  }
}

export async function renderWebGL2(frame: SubtitleData): Promise<BackendRenderResult> {
  if (typeof document === 'undefined' || !isWebGL2Supported()) {
    return {
      backend: 'webgl2',
      pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
      skipped: 'WebGL2 not supported'
    }
  }

  const canvas = document.createElement('canvas')
  const renderer = new WebGL2Renderer()
  try {
    await renderer.init()
    await renderer.setCanvas(canvas, frame.width, frame.height)
    renderer.render(toCompositionData(frame), frame.width, frame.height, 1, 1, 0, 0, 1)
    const pixels = renderer.readPixels()
    return { backend: 'webgl2', pixels }
  } catch (error) {
    return {
      backend: 'webgl2',
      pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
      skipped: error instanceof Error ? error.message : String(error)
    }
  } finally {
    renderer.destroy()
  }
}

export async function renderWebGPU(frame: SubtitleData): Promise<BackendRenderResult> {
  if (typeof document === 'undefined' || !isWebGPUSupported()) {
    return {
      backend: 'webgpu',
      pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
      skipped: 'WebGPU not supported'
    }
  }

  const canvas = document.createElement('canvas')
  const renderer = new WebGPURenderer()
  try {
    await renderer.init()
    await renderer.setCanvas(canvas, frame.width, frame.height)
    renderer.render(toCompositionData(frame), frame.width, frame.height, 1, 1, 0, 0, 1)
    const pixels = await renderer.readPixels()
    return { backend: 'webgpu', pixels }
  } catch (error) {
    return {
      backend: 'webgpu',
      pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
      skipped: error instanceof Error ? error.message : String(error)
    }
  } finally {
    renderer.destroy()
  }
}

export async function renderAllBackends(frame: SubtitleData): Promise<BackendRenderResult[]> {
  const software = renderSoftwareGolden(frame)
  const canvas2d = renderCanvas2D(frame)
  const webgl2 = await renderWebGL2(frame)
  const webgpu = await renderWebGPU(frame)
  return [software, canvas2d, webgl2, webgpu]
}
