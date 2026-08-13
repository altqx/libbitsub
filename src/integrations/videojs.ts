/**
 * Optional Video.js plugin for libbitsub bitmap subtitles.
 *
 * @module
 *
 * @example
 * ```ts
 * import videojs from 'video.js'
 * import { registerBitSubPlugin } from 'libbitsub/videojs'
 *
 * registerBitSubPlugin(videojs)
 * const player = videojs('my-video')
 * player.bitsub({ subUrl: '/subs/movie.sup' })
 * ```
 */

import { attachBitSub, type AttachBitSubOptions, type BitSubController, type BitSubSourceOptions } from './shared'

/** Minimal Video.js surface used by the plugin (avoids a hard dependency). */
export interface VideoJsPlayerLike {
  ready(callback: (this: this) => void): this
  el(): HTMLElement | null
  tech?: (asHtml?: boolean) => { el?: () => HTMLElement | null } | HTMLElement | null | undefined
  on(type: string, handler: (...args: unknown[]) => void): this
  off?(type: string, handler: (...args: unknown[]) => void): this
  addClass?(className: string): void
  removeClass?(className: string): void
  trigger?(event: string, data?: unknown): void
}

/** Minimal Video.js plugin instance surface. */
export interface VideoJsPluginBase {
  player: VideoJsPlayerLike
  options_: unknown
  dispose(): void
}

/** Minimal Video.js plugin constructor surface. */
export interface VideoJsPluginConstructor {
  new (player: VideoJsPlayerLike, options?: unknown): VideoJsPluginBase
  prototype: VideoJsPluginBase
}

/** Minimal video.js factory used by the plugin. */
export interface VideoJsLike {
  getPlugin(name: string): VideoJsPluginConstructor
  registerPlugin(name: string, plugin: unknown): void
}

/** Options for player.bitsub(). */
export type BitSubVideoJsOptions = AttachBitSubOptions

/** Video.js player.bitsub() API. */
export interface BitSubVideoJsApi {
  /** Active controller, if any. */
  controller(): BitSubController | null
  /** Load or replace the subtitle track. */
  load(source: BitSubSourceOptions): void
  /** Clear the current track. */
  clear(): void
  /** Dispose plugin-owned resources (also runs on player dispose). */
  dispose(): void
  setDisplaySettings(settings: Parameters<BitSubController['setDisplaySettings']>[0]): void
  getDisplaySettings(): ReturnType<BitSubController['getDisplaySettings']>
  getStats(): ReturnType<BitSubController['getStats']>
}

function resolveVideoElement(player: VideoJsPlayerLike): HTMLVideoElement | null {
  const tech = typeof player.tech === 'function' ? player.tech(true) : undefined
  const techEl =
    tech && typeof (tech as { el?: () => HTMLElement | null }).el === 'function'
      ? (tech as { el: () => HTMLElement | null }).el()
      : (tech as HTMLElement | null | undefined)

  if (techEl instanceof HTMLVideoElement) return techEl

  const root = player.el()
  if (!root) return null
  return root.querySelector('video')
}

/**
 * Register the `bitsub` Video.js plugin.
 * Safe to call multiple times — subsequent calls are no-ops once registered.
 */
export function registerBitSubPlugin(videojs: VideoJsLike, pluginName = 'bitsub'): void {
  const existing = typeof videojs.getPlugin === 'function' ? videojs.getPlugin(pluginName) : undefined
  // Only skip when a previous registerBitSubPlugin call marked the plugin.
  if (existing && (existing as { __libbitsubPlugin?: boolean }).__libbitsubPlugin) {
    return
  }

  const Plugin = videojs.getPlugin('plugin')

  class BitSubPlugin extends Plugin implements BitSubVideoJsApi {
    private controllerRef: BitSubController | null = null
    private readonly onDispose: () => void
    private readonly onLoadedData: () => void
    private readonly initialOptions: BitSubVideoJsOptions

    constructor(player: VideoJsPlayerLike, options: BitSubVideoJsOptions = {}) {
      super(player, options)
      this.initialOptions = options

      this.onDispose = () => this.disposeController()
      this.onLoadedData = () => this.ensureController(this.initialOptions, false)

      player.ready(() => {
        this.ensureController(options, true)
        player.on('loadeddata', this.onLoadedData)
        player.on('dispose', this.onDispose)
        player.addClass?.('vjs-bitsub')
      })
    }

    controller(): BitSubController | null {
      return this.controllerRef
    }

    load(source: BitSubSourceOptions): void {
      const controller = this.ensureController({}, false)
      controller.load(source)
      this.player.trigger?.('bitsubload', source)
    }

    clear(): void {
      this.controllerRef?.clear()
      this.player.trigger?.('bitsubclear')
    }

    setDisplaySettings(settings: Parameters<BitSubController['setDisplaySettings']>[0]): void {
      this.controllerRef?.setDisplaySettings(settings)
    }

    getDisplaySettings(): ReturnType<BitSubController['getDisplaySettings']> {
      return this.controllerRef?.getDisplaySettings() ?? null
    }

    getStats(): ReturnType<BitSubController['getStats']> {
      return this.controllerRef?.getStats() ?? null
    }

    override dispose(): void {
      this.player.off?.('loadeddata', this.onLoadedData)
      this.player.off?.('dispose', this.onDispose)
      this.player.removeClass?.('vjs-bitsub')
      this.disposeController()
      super.dispose()
    }

    private disposeController(): void {
      this.controllerRef?.dispose()
      this.controllerRef = null
    }

    private ensureController(options: BitSubVideoJsOptions, allowAutoload: boolean): BitSubController {
      const video = resolveVideoElement(this.player)
      if (!video) {
        throw new Error('libbitsub Video.js plugin could not resolve an HTMLVideoElement')
      }

      if (this.controllerRef && !this.controllerRef.disposed) {
        if (this.controllerRef.video !== video) {
          this.controllerRef.setVideo(video)
        }
        return this.controllerRef
      }

      const { autoLoad = true, ...source } = options
      this.controllerRef = attachBitSub(video, {
        ...source,
        autoLoad: allowAutoload ? autoLoad : false
      })
      return this.controllerRef
    }
  }

  ;(BitSubPlugin as unknown as { __libbitsubPlugin?: boolean }).__libbitsubPlugin = true
  videojs.registerPlugin(pluginName, BitSubPlugin)
}

/**
 * Ambient augmentation helper for apps using the default plugin name `bitsub`.
 *
 * @example
 * ```ts
 * import 'libbitsub/videojs' // side-effect free; types only when referenced
 * // or in a global.d.ts:
 * // import type {} from 'libbitsub/videojs'
 * ```
 *
 * For full player typing, extend your video.js module:
 * ```ts
 * import type { BitSubVideoJsApi, BitSubVideoJsOptions } from 'libbitsub/videojs'
 * declare module 'video.js' {
 *   interface VideoJsPlayer {
 *     bitsub(options?: BitSubVideoJsOptions): BitSubVideoJsApi
 *   }
 * }
 * ```
 */
export type VideoJsBitSubPlayer = VideoJsPlayerLike & {
  bitsub(options?: BitSubVideoJsOptions): BitSubVideoJsApi
}

/** Shared attach options and controller types. */
export type { AttachBitSubOptions, BitSubController, BitSubSourceOptions, BitSubRenderer } from './shared'
/** Attach or construct a libbitsub controller. */
export { attachBitSub, createBitSubRenderer } from './shared'
