/**
 * Minimal ImageData polyfill for Bun/Node unit tests.
 * Browser environments already provide ImageData.
 */

export function ensureImageDataPolyfill(): void {
  if (typeof globalThis.ImageData !== 'undefined') return

  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray
    readonly width: number
    readonly height: number
    readonly colorSpace: PredefinedColorSpace = 'srgb'

    constructor(width: number, height: number)
    constructor(data: Uint8ClampedArray, width: number, height?: number)
    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      widthOrHeight: number,
      maybeHeight?: number
    ) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth
        this.height = widthOrHeight
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
        return
      }

      this.data = dataOrWidth
      this.width = widthOrHeight
      this.height = maybeHeight ?? Math.floor(dataOrWidth.length / (4 * widthOrHeight))
    }
  }

  ;(globalThis as typeof globalThis & { ImageData: typeof ImageData }).ImageData =
    ImageDataPolyfill as unknown as typeof ImageData
}
