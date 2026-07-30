/**
 * Optional React bindings for libbitsub bitmap subtitles.
 *
 * Peer dependency: react >= 18
 *
 * @example
 * ```tsx
 * import { useRef } from 'react'
 * import { useBitSub } from 'libbitsub/react'
 *
 * function Player({ src, subUrl }: { src: string; subUrl: string }) {
 *   const videoRef = useRef<HTMLVideoElement>(null)
 *   useBitSub(videoRef, { subUrl })
 *   return (
 *     <div style={{ position: 'relative' }}>
 *       <video ref={videoRef} src={src} controls playsInline />
 *     </div>
 *   )
 * }
 * ```
 *
 * Prefer either `useBitSub` *or* `BitSubOverlay` for a given video — not both.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from 'react'
import { attachBitSub, type AttachBitSubOptions, type BitSubController, type BitSubSourceOptions } from './shared'
import type { SubtitleDisplaySettings, SubtitleDiagnosticWarning, SubtitleRendererEvent } from '../wrapper'

export type BitSubReactSource = BitSubSourceOptions

export interface UseBitSubOptions extends BitSubReactSource {
  /** When false, do not load even if source fields are set. Default true. */
  enabled?: boolean
}

export interface UseBitSubResult {
  controller: BitSubController | null
  error: Error | null
}

function sourceKey(source: BitSubReactSource | null | undefined): string {
  if (!source) return ''
  return JSON.stringify({
    subUrl: source.subUrl ?? null,
    idxUrl: source.idxUrl ?? null,
    fileName: source.fileName ?? null,
    hasSubContent: Boolean(source.subContent),
    hasIdxContent: Boolean(source.idxContent),
    cacheLimit: source.cacheLimit ?? null,
    timeOffset: source.timeOffset ?? null,
    streamingLoad: source.streamingLoad ?? null,
    rangeRequests: source.rangeRequests ?? null,
    debug: source.debug ?? null,
    displaySettings: source.displaySettings ?? null,
    prefetchWindow: source.prefetchWindow ?? null
  })
}

/**
 * Bind a libbitsub renderer to a video element ref for the lifetime of the source.
 * Cleans up automatically on unmount or when the source identity changes.
 */
export function useBitSub(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: UseBitSubOptions | null
): UseBitSubResult {
  const controllerRef = useRef<BitSubController | null>(null)
  const [controller, setController] = useState<BitSubController | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const onEventRef = useRef<((event: SubtitleRendererEvent) => void) | undefined>(undefined)
  const onWarningRef = useRef<((warning: SubtitleDiagnosticWarning) => void) | undefined>(undefined)
  const onErrorRef = useRef<((error: Error) => void) | undefined>(undefined)
  const onLoadingRef = useRef<(() => void) | undefined>(undefined)
  const onLoadedRef = useRef<(() => void) | undefined>(undefined)

  onEventRef.current = options?.onEvent
  onWarningRef.current = options?.onWarning
  onErrorRef.current = options?.onError
  onLoadingRef.current = options?.onLoading
  onLoadedRef.current = options?.onLoaded

  const enabled = options?.enabled !== false
  const key = sourceKey(options)
  const displaySettings = options?.displaySettings

  useEffect(() => {
    setError(null)
    const video = videoRef.current
    if (!video || !options || !enabled) {
      controllerRef.current?.dispose()
      controllerRef.current = null
      setController(null)
      return
    }

    const {
      enabled: _enabled,
      onEvent: _onEvent,
      onWarning: _onWarning,
      onError: _onError,
      onLoading: _onLoading,
      onLoaded: _onLoaded,
      ...source
    } = options

    const attachOptions: AttachBitSubOptions = {
      ...source,
      onEvent: (event) => onEventRef.current?.(event),
      onWarning: (warning) => onWarningRef.current?.(warning),
      onError: (err) => {
        setError(err)
        onErrorRef.current?.(err)
      },
      onLoading: () => onLoadingRef.current?.(),
      onLoaded: () => onLoadedRef.current?.()
    }

    try {
      const next = attachBitSub(video, attachOptions)
      controllerRef.current = next
      setController(next)
      return () => {
        next.dispose()
        if (controllerRef.current === next) {
          controllerRef.current = null
          setController(null)
        }
      }
    } catch (err) {
      const resolved = err instanceof Error ? err : new Error(String(err))
      setError(resolved)
      onErrorRef.current?.(resolved)
      controllerRef.current = null
      setController(null)
    }
    // key captures source identity; callback props stay fresh via refs
  }, [videoRef, key, enabled])

  useEffect(() => {
    if (displaySettings) {
      controllerRef.current?.setDisplaySettings(displaySettings)
    }
  }, [displaySettings])

  return { controller, error }
}

export interface BitSubOverlayProps extends UseBitSubOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  /** Optional class name applied to a zero-size host span for debugging. */
  className?: string
  style?: CSSProperties
}

/**
 * Declarative overlay helper. Renders nothing visible itself — libbitsub attaches
 * its canvas next to the video element. Useful when you want JSX-configured tracks.
 */
export function BitSubOverlay(props: BitSubOverlayProps): ReactElement | null {
  const { videoRef, className, style, ...options } = props
  useBitSub(videoRef, options)

  if (!className && !style) return null
  return <span className={className} style={{ display: 'none', ...style }} aria-hidden='true' />
}

export type { AttachBitSubOptions, BitSubController, BitSubSourceOptions, BitSubRenderer } from './shared'
export { attachBitSub, createBitSubRenderer } from './shared'
export type { SubtitleDisplaySettings }
