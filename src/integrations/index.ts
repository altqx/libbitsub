/**
 * Optional player integrations for libbitsub.
 *
 * Prefer deep imports (`libbitsub/videojs`, `libbitsub/shaka`, `libbitsub/hlsjs`,
 * `libbitsub/react`) so unused peer dependencies stay out of your bundle.
 *
 * @module
 */

/** Shared attach/create helpers used by every player adapter. */
export {
  attachBitSub,
  createBitSubRenderer,
  type AttachBitSubOptions,
  type BitSubController,
  type BitSubRenderer,
  type BitSubSourceOptions
} from './shared'

/** Video.js plugin and player typings. */
export {
  registerBitSubPlugin,
  type BitSubVideoJsApi,
  type BitSubVideoJsOptions,
  type VideoJsBitSubPlayer,
  type VideoJsLike,
  type VideoJsPlayerLike
} from './videojs'

/** Shaka Player adapter. */
export { attachBitSubToShaka, type BitSubShakaHandle, type BitSubShakaOptions, type ShakaPlayerLike } from './shaka'

/** hls.js adapter. */
export { attachBitSubToHls, type BitSubHlsHandle, type BitSubHlsOptions, type HlsLike } from './hlsjs'

/** React hook and overlay component. */
export {
  BitSubOverlay,
  useBitSub,
  type BitSubOverlayProps,
  type BitSubReactSource,
  type UseBitSubOptions,
  type UseBitSubResult
} from './react'
