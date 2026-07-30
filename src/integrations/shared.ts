/**
 * Shared player-integration helpers for libbitsub.
 * Optional adapters build on this surface so the core package stays dependency-free.
 */

import {
  createAutoSubtitleRenderer,
  type AutoVideoSubtitleOptions,
  type PgsRenderer,
  type SubtitleDisplaySettings,
  type SubtitleRendererStats,
  type VobSubRenderer
} from '../wrapper'

/** High-level renderer produced by integrations. */
export type BitSubRenderer = PgsRenderer | VobSubRenderer

/** Subtitle source + renderer options without a bound video element. */
export type BitSubSourceOptions = Omit<AutoVideoSubtitleOptions, 'video'>

export interface BitSubController {
  /** Active renderer, or null when no track is loaded. */
  readonly renderer: BitSubRenderer | null
  /** Currently bound video element. */
  readonly video: HTMLVideoElement | null
  /** Load or replace the active subtitle track. */
  load(source: BitSubSourceOptions): BitSubRenderer
  /** Remove the active track without disposing the controller. */
  clear(): void
  /** Tear down the renderer and release the controller. */
  dispose(): void
  /** Whether {@link dispose} has already been called. */
  readonly disposed: boolean
  getDisplaySettings(): SubtitleDisplaySettings | null
  setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void
  resetDisplaySettings(): void
  getStats(): SubtitleRendererStats | null
  /** Rebind to another video element, keeping the last source when present. */
  setVideo(video: HTMLVideoElement | null): void
}

export interface AttachBitSubOptions extends BitSubSourceOptions {
  /** When false, skip the initial load even if source fields are present. Default true. */
  autoLoad?: boolean
}

function hasSubtitleSource(source: BitSubSourceOptions | undefined): boolean {
  if (!source) return false
  return Boolean(source.subUrl || source.subContent || source.idxUrl || source.idxContent || source.fileName)
}

function assertVideo(video: HTMLVideoElement | null | undefined): HTMLVideoElement {
  if (!video) {
    throw new Error('libbitsub integration requires an HTMLVideoElement')
  }
  return video
}

/**
 * Attach a disposable controller to a video element.
 * Call {@link BitSubController.load} to start a track, or pass source fields to auto-load.
 */
export function attachBitSub(video: HTMLVideoElement, options: AttachBitSubOptions = {}): BitSubController {
  const { autoLoad = true, ...initialSource } = options
  let disposed = false
  let boundVideo: HTMLVideoElement | null = video
  let renderer: BitSubRenderer | null = null
  let lastSource: BitSubSourceOptions | null = hasSubtitleSource(initialSource) ? { ...initialSource } : null

  const clearRenderer = (): void => {
    if (!renderer) return
    renderer.dispose()
    renderer = null
  }

  const controller: BitSubController = {
    get renderer() {
      return renderer
    },
    get video() {
      return boundVideo
    },
    get disposed() {
      return disposed
    },
    load(source: BitSubSourceOptions): BitSubRenderer {
      if (disposed) {
        throw new Error('BitSubController has been disposed')
      }
      const activeVideo = assertVideo(boundVideo)
      if (!hasSubtitleSource(source)) {
        throw new Error('BitSubController.load requires subUrl, subContent, or a detectable fileName')
      }

      clearRenderer()
      lastSource = { ...source }
      renderer = createAutoSubtitleRenderer({
        ...source,
        video: activeVideo
      })
      return renderer
    },
    clear(): void {
      if (disposed) return
      clearRenderer()
      lastSource = null
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      clearRenderer()
      lastSource = null
      boundVideo = null
    },
    getDisplaySettings(): SubtitleDisplaySettings | null {
      return renderer?.getDisplaySettings() ?? null
    },
    setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void {
      renderer?.setDisplaySettings(settings)
    },
    resetDisplaySettings(): void {
      renderer?.resetDisplaySettings()
    },
    getStats(): SubtitleRendererStats | null {
      return renderer?.getStats() ?? null
    },
    setVideo(nextVideo: HTMLVideoElement | null): void {
      if (disposed) {
        throw new Error('BitSubController has been disposed')
      }

      if (nextVideo === boundVideo) {
        // Same element: still materialize a pending source (e.g. delayed autoLoad).
        if (nextVideo && !renderer && lastSource) {
          renderer = createAutoSubtitleRenderer({
            ...lastSource,
            video: nextVideo
          })
        }
        return
      }

      const previousSource = lastSource
      clearRenderer()
      boundVideo = nextVideo

      if (nextVideo && previousSource) {
        lastSource = previousSource
        renderer = createAutoSubtitleRenderer({
          ...previousSource,
          video: nextVideo
        })
      }
    }
  }

  if (autoLoad && lastSource) {
    controller.load(lastSource)
  }

  return controller
}

/** Convenience one-shot helper used by thin player wrappers. */
export function createBitSubRenderer(video: HTMLVideoElement, source: BitSubSourceOptions): BitSubRenderer {
  return createAutoSubtitleRenderer({
    ...source,
    video: assertVideo(video)
  })
}
