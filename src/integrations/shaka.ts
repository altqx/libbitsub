/**
 * Optional Shaka Player adapter for libbitsub bitmap subtitles.
 *
 * Bitmap PGS/VobSub tracks are not native Shaka text tracks — this helper
 * overlays libbitsub on the player media element.
 *
 * @example
 * ```ts
 * import shaka from 'shaka-player'
 * import { attachBitSubToShaka } from 'libbitsub/shaka'
 *
 * const player = new shaka.Player(video)
 * await player.load(manifestUri)
 * const bitsub = attachBitSubToShaka(player, { subUrl: '/subs/movie.sup' })
 * // later
 * bitsub.dispose()
 * ```
 */

import { attachBitSub, type AttachBitSubOptions, type BitSubController } from './shared'

/** Minimal Shaka Player surface used by the adapter. */
export interface ShakaPlayerLike {
  getMediaElement(): HTMLMediaElement | null
  addEventListener?(type: string, listener: (...args: unknown[]) => void): void
  removeEventListener?(type: string, listener: (...args: unknown[]) => void): void
}

export type BitSubShakaOptions = AttachBitSubOptions

export interface BitSubShakaHandle extends BitSubController {
  /** Underlying Shaka player reference. */
  readonly player: ShakaPlayerLike
}

/**
 * Attach libbitsub to a Shaka Player instance.
 * Rebinds automatically when Shaka swaps the media element (if event APIs exist).
 */
export function attachBitSubToShaka(player: ShakaPlayerLike, options: BitSubShakaOptions = {}): BitSubShakaHandle {
  const media = player.getMediaElement()
  if (!(media instanceof HTMLVideoElement)) {
    throw new Error('libbitsub Shaka adapter requires a player with an HTMLVideoElement media element')
  }

  const controller = attachBitSub(media, options)

  const onLoaded = (): void => {
    if (controller.disposed) return
    const next = player.getMediaElement()
    if (next instanceof HTMLVideoElement) {
      controller.setVideo(next)
    }
  }

  const onUnloading = (): void => {
    if (!controller.disposed) controller.clear()
  }

  player.addEventListener?.('loaded', onLoaded)
  player.addEventListener?.('unloading', onUnloading)

  const dispose = (): void => {
    player.removeEventListener?.('loaded', onLoaded)
    player.removeEventListener?.('unloading', onUnloading)
    controller.dispose()
  }

  return {
    player,
    get renderer() {
      return controller.renderer
    },
    get video() {
      return controller.video
    },
    get disposed() {
      return controller.disposed
    },
    load: (source) => controller.load(source),
    clear: () => controller.clear(),
    dispose,
    getDisplaySettings: () => controller.getDisplaySettings(),
    setDisplaySettings: (settings) => controller.setDisplaySettings(settings),
    resetDisplaySettings: () => controller.resetDisplaySettings(),
    getStats: () => controller.getStats(),
    setVideo: (video) => controller.setVideo(video)
  }
}

export type { AttachBitSubOptions, BitSubController, BitSubSourceOptions, BitSubRenderer } from './shared'
export { attachBitSub, createBitSubRenderer } from './shared'
