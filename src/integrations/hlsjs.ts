/**
 * Optional hls.js adapter for libbitsub bitmap subtitles.
 *
 * hls.js handles HLS media and WebVTT/IMSC text tracks; use this helper for
 * external PGS/VobSub/MKS bitmap overlays on the same media element.
 *
 * @module
 *
 * @example
 * ```ts
 * import Hls from 'hls.js'
 * import { attachBitSubToHls } from 'libbitsub/hlsjs'
 *
 * const hls = new Hls()
 * hls.loadSource(playlistUrl)
 * hls.attachMedia(video)
 * const bitsub = attachBitSubToHls(hls, { subUrl: '/subs/movie.sup' })
 * // later
 * bitsub.dispose()
 * ```
 */

import { attachBitSub, type AttachBitSubOptions, type BitSubController, type BitSubSourceOptions } from './shared'

/** Minimal hls.js surface used by the adapter. */
export interface HlsLike {
  media: HTMLMediaElement | null
  on?(event: string, listener: (...args: unknown[]) => void): void
  off?(event: string, listener: (...args: unknown[]) => void): void
  /** hls.js Events map — optional so callers can pass event name strings. */
  Events?: {
    MEDIA_ATTACHED?: string
    MEDIA_DETACHED?: string
    DESTROYING?: string
  }
}

/** Options for attachBitSubToHls(). */
export type BitSubHlsOptions = AttachBitSubOptions

/** Handle returned by attachBitSubToHls(). */
export interface BitSubHlsHandle extends BitSubController {
  /** Underlying hls.js instance. */
  readonly hls: HlsLike
}

function eventName(hls: HlsLike, key: 'MEDIA_ATTACHED' | 'MEDIA_DETACHED' | 'DESTROYING', fallback: string): string {
  return hls.Events?.[key] ?? fallback
}

function hasSubtitleSource(source: BitSubSourceOptions): boolean {
  return Boolean(source.subUrl || source.subContent || source.idxUrl || source.idxContent || source.fileName)
}

/**
 * Attach libbitsub to an hls.js instance.
 * Binds to `hls.media` and re-attaches on MEDIA_ATTACHED when event APIs exist.
 */
export function attachBitSubToHls(hls: HlsLike, options: BitSubHlsOptions = {}): BitSubHlsHandle {
  const initialMedia = hls.media
  if (initialMedia && !(initialMedia instanceof HTMLVideoElement)) {
    throw new Error('libbitsub hls.js adapter requires hls.media to be an HTMLVideoElement')
  }

  // Allow constructing before attachMedia(); load waits until a video is available.
  const placeholderVideo = initialMedia instanceof HTMLVideoElement ? initialMedia : document.createElement('video')
  const { autoLoad: initialAutoLoad = true, ...initialSource } = options
  let lastSource: BitSubSourceOptions = { ...initialSource }
  let autoLoad = initialAutoLoad

  const controller = attachBitSub(placeholderVideo, {
    ...initialSource,
    autoLoad: initialMedia instanceof HTMLVideoElement ? initialAutoLoad : false
  })

  const bindMedia = (media: HTMLMediaElement | null): void => {
    if (controller.disposed) return
    if (media && !(media instanceof HTMLVideoElement)) {
      throw new Error('libbitsub hls.js adapter requires hls.media to be an HTMLVideoElement')
    }

    if (!media) {
      controller.setVideo(null)
      return
    }

    // setVideo reloads the last source when present; otherwise load explicitly if autoLoad.
    const needsExplicitLoad = autoLoad && hasSubtitleSource(lastSource) && controller.renderer === null
    controller.setVideo(media)
    if (needsExplicitLoad && controller.renderer === null && hasSubtitleSource(lastSource)) {
      controller.load(lastSource)
    }
  }

  const onMediaAttached = (): void => bindMedia(hls.media)
  const onMediaDetached = (): void => {
    if (!controller.disposed) controller.clear()
  }
  const onDestroying = (): void => dispose()

  const mediaAttached = eventName(hls, 'MEDIA_ATTACHED', 'hlsMediaAttached')
  const mediaDetached = eventName(hls, 'MEDIA_DETACHED', 'hlsMediaDetached')
  const destroying = eventName(hls, 'DESTROYING', 'hlsDestroying')

  hls.on?.(mediaAttached, onMediaAttached)
  hls.on?.(mediaDetached, onMediaDetached)
  hls.on?.(destroying, onDestroying)

  if (initialMedia instanceof HTMLVideoElement) {
    bindMedia(initialMedia)
  }

  const dispose = (): void => {
    hls.off?.(mediaAttached, onMediaAttached)
    hls.off?.(mediaDetached, onMediaDetached)
    hls.off?.(destroying, onDestroying)
    controller.dispose()
  }

  return {
    hls,
    get renderer() {
      return controller.renderer
    },
    get video() {
      return controller.video
    },
    get disposed() {
      return controller.disposed
    },
    load: (source) => {
      lastSource = { ...source }
      autoLoad = true
      if (!(controller.video instanceof HTMLVideoElement) || controller.video === placeholderVideo) {
        const media = hls.media
        if (media instanceof HTMLVideoElement) {
          controller.setVideo(media)
        } else {
          throw new Error('libbitsub hls.js adapter: call hls.attachMedia(video) before load()')
        }
      }
      return controller.load(source)
    },
    clear: () => {
      autoLoad = false
      controller.clear()
    },
    dispose,
    getDisplaySettings: () => controller.getDisplaySettings(),
    setDisplaySettings: (settings) => controller.setDisplaySettings(settings),
    resetDisplaySettings: () => controller.resetDisplaySettings(),
    getStats: () => controller.getStats(),
    setVideo: (video) => controller.setVideo(video)
  }
}

/** Shared attach options and controller types. */
export type { AttachBitSubOptions, BitSubController, BitSubSourceOptions, BitSubRenderer } from './shared'
/** Attach or construct a libbitsub controller. */
export { attachBitSub, createBitSubRenderer } from './shared'
