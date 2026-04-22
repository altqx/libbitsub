import type {
  SubtitleData,
  SubtitleFrameCanvasOptions,
  SubtitleFrameCanvasTarget,
  SubtitleFrameCropMode,
  SubtitleFrameRenderOptions,
  SubtitleRenderedFrameData
} from './types'
import { getSubtitleBounds } from './utils'

function blendSourceOver(dst: Uint8ClampedArray, dstIndex: number, src: Uint8ClampedArray, srcIndex: number): void {
  const srcAlpha = src[srcIndex + 3]
  if (srcAlpha === 0) return

  if (srcAlpha === 255) {
    dst[dstIndex] = src[srcIndex]
    dst[dstIndex + 1] = src[srcIndex + 1]
    dst[dstIndex + 2] = src[srcIndex + 2]
    dst[dstIndex + 3] = 255
    return
  }

  const dstAlpha = dst[dstIndex + 3]
  if (dstAlpha === 0) {
    dst[dstIndex] = src[srcIndex]
    dst[dstIndex + 1] = src[srcIndex + 1]
    dst[dstIndex + 2] = src[srcIndex + 2]
    dst[dstIndex + 3] = srcAlpha
    return
  }

  const srcAlphaNorm = srcAlpha / 255
  const dstAlphaNorm = dstAlpha / 255
  const outAlphaNorm = srcAlphaNorm + dstAlphaNorm * (1 - srcAlphaNorm)

  if (outAlphaNorm <= 0) {
    dst[dstIndex] = 0
    dst[dstIndex + 1] = 0
    dst[dstIndex + 2] = 0
    dst[dstIndex + 3] = 0
    return
  }

  const srcRed = src[srcIndex] * srcAlphaNorm
  const srcGreen = src[srcIndex + 1] * srcAlphaNorm
  const srcBlue = src[srcIndex + 2] * srcAlphaNorm
  const dstRed = dst[dstIndex] * dstAlphaNorm
  const dstGreen = dst[dstIndex + 1] * dstAlphaNorm
  const dstBlue = dst[dstIndex + 2] * dstAlphaNorm

  dst[dstIndex] = Math.round((srcRed + dstRed * (1 - srcAlphaNorm)) / outAlphaNorm)
  dst[dstIndex + 1] = Math.round((srcGreen + dstGreen * (1 - srcAlphaNorm)) / outAlphaNorm)
  dst[dstIndex + 2] = Math.round((srcBlue + dstBlue * (1 - srcAlphaNorm)) / outAlphaNorm)
  dst[dstIndex + 3] = Math.round(outAlphaNorm * 255)
}

function resolveCropMode(frame: SubtitleData | SubtitleRenderedFrameData, options?: SubtitleFrameRenderOptions): SubtitleFrameCropMode {
  if ('imageData' in frame) {
    return options?.crop ?? frame.crop
  }

  return options?.crop ?? 'bounds'
}

function getEmptyFrameSize(frame: SubtitleData | SubtitleRenderedFrameData, crop: SubtitleFrameCropMode): { width: number; height: number } {
  if ('imageData' in frame) {
    return {
      width: Math.max(1, frame.imageData.width),
      height: Math.max(1, frame.imageData.height)
    }
  }

  if (crop === 'screen') {
    return {
      width: Math.max(1, frame.width),
      height: Math.max(1, frame.height)
    }
  }

  return { width: 1, height: 1 }
}

function isCanvasContext(target: SubtitleFrameCanvasTarget): target is CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  return 'putImageData' in target && 'canvas' in target
}

function resizeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): void {
  canvas.width = width
  canvas.height = height
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

  throw new Error('Canvas export requires OffscreenCanvas or document.createElement("canvas").')
}

function getCanvasContext(canvas: HTMLCanvasElement | OffscreenCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not acquire a 2D canvas context for subtitle frame export.')
  }

  return context
}

function isHtmlCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): canvas is HTMLCanvasElement {
  return 'toBlob' in canvas
}

function normalizeRenderedFrame(
  frame: SubtitleData | SubtitleRenderedFrameData,
  options?: SubtitleFrameRenderOptions
): SubtitleRenderedFrameData | null {
  if ('imageData' in frame) {
    if (!options?.crop || options.crop === frame.crop) {
      return frame
    }

    return renderFrameData(
      {
        width: frame.screenWidth,
        height: frame.screenHeight,
        compositionData: [
          {
            pixelData: frame.imageData,
            x: frame.offsetX,
            y: frame.offsetY
          }
        ]
      },
      options
    )
  }

  return renderFrameData(frame, options)
}

export function renderFrameData(frame: SubtitleData, options: SubtitleFrameRenderOptions = {}): SubtitleRenderedFrameData | null {
  const crop = options.crop ?? 'bounds'
  const bounds = getSubtitleBounds(frame)

  if (!bounds && crop === 'bounds') {
    return null
  }

  const offsetX = crop === 'screen' ? 0 : bounds?.x ?? 0
  const offsetY = crop === 'screen' ? 0 : bounds?.y ?? 0
  const targetWidth = Math.max(1, crop === 'screen' ? frame.width : bounds?.width ?? 1)
  const targetHeight = Math.max(1, crop === 'screen' ? frame.height : bounds?.height ?? 1)
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4)

  for (const composition of frame.compositionData) {
    const src = composition.pixelData.data
    const srcWidth = composition.pixelData.width
    const srcHeight = composition.pixelData.height

    if (srcWidth <= 0 || srcHeight <= 0) continue

    const dstX = composition.x - offsetX
    const dstY = composition.y - offsetY
    const startX = Math.max(0, dstX)
    const startY = Math.max(0, dstY)
    const endX = Math.min(targetWidth, dstX + srcWidth)
    const endY = Math.min(targetHeight, dstY + srcHeight)

    if (startX >= endX || startY >= endY) continue

    for (let y = startY; y < endY; y += 1) {
      const srcY = y - dstY

      for (let x = startX; x < endX; x += 1) {
        const srcX = x - dstX
        const srcIndex = (srcY * srcWidth + srcX) * 4
        const dstIndex = (y * targetWidth + x) * 4
        blendSourceOver(output, dstIndex, src, srcIndex)
      }
    }
  }

  return {
    imageData: new ImageData(output, targetWidth, targetHeight),
    bounds,
    offsetX,
    offsetY,
    screenWidth: frame.width,
    screenHeight: frame.height,
    crop,
    compositionCount: frame.compositionData.length
  }
}

export function toCanvas(
  frame: SubtitleData | SubtitleRenderedFrameData,
  target?: SubtitleFrameCanvasTarget,
  options: SubtitleFrameCanvasOptions = {}
): HTMLCanvasElement | OffscreenCanvas {
  const rendered = normalizeRenderedFrame(frame, options)
  const crop = resolveCropMode(frame, options)
  const fallbackSize = rendered
    ? { width: rendered.imageData.width, height: rendered.imageData.height }
    : getEmptyFrameSize(frame, crop)

  let canvas: HTMLCanvasElement | OffscreenCanvas
  let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

  if (target) {
    if (isCanvasContext(target)) {
      canvas = target.canvas
      context = target
    } else {
      canvas = target
      context = getCanvasContext(canvas)
    }
  } else {
    canvas = createCanvas(fallbackSize.width, fallbackSize.height)
    context = getCanvasContext(canvas)
  }

  const resizeTarget = options.resizeCanvas ?? (target ? !isCanvasContext(target) : true)
  if (resizeTarget) {
    resizeCanvas(canvas, fallbackSize.width, fallbackSize.height)
    context = getCanvasContext(canvas)
  }

  const clearCanvas = options.clearCanvas ?? !resizeTarget
  if (clearCanvas) {
    context.clearRect(0, 0, canvas.width, canvas.height)
  }

  if (rendered) {
    const drawX = resizeTarget ? 0 : rendered.offsetX
    const drawY = resizeTarget ? 0 : rendered.offsetY
    context.putImageData(rendered.imageData, drawX, drawY)
  }

  return canvas
}

export async function toImageBitmap(
  frame: SubtitleData | SubtitleRenderedFrameData,
  options: SubtitleFrameRenderOptions = {}
): Promise<ImageBitmap> {
  const rendered = normalizeRenderedFrame(frame, options)
  if (rendered && typeof createImageBitmap === 'function') {
    return createImageBitmap(rendered.imageData)
  }

  const canvas = toCanvas(frame, undefined, {
    ...options,
    resizeCanvas: true,
    clearCanvas: false
  })

  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(canvas)
  }

  if ('transferToImageBitmap' in canvas && typeof canvas.transferToImageBitmap === 'function') {
    return canvas.transferToImageBitmap()
  }

  throw new Error('ImageBitmap export requires createImageBitmap() or OffscreenCanvas.transferToImageBitmap().')
}

export async function toBlob(
  frame: SubtitleData | SubtitleRenderedFrameData,
  type: string = 'image/png',
  quality?: number,
  options: SubtitleFrameRenderOptions = {}
): Promise<Blob> {
  const canvas = toCanvas(frame, undefined, {
    ...options,
    resizeCanvas: true,
    clearCanvas: false
  })

  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality })
  }

  if (!isHtmlCanvas(canvas)) {
    throw new Error('Blob export requires HTMLCanvasElement.toBlob() or OffscreenCanvas.convertToBlob().')
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob: Blob | null) => {
      if (blob) {
        resolve(blob)
        return
      }

      reject(new Error('Failed to encode subtitle frame blob.'))
    }, type, quality)
  })
}