/**
 * Optional player integrations for libbitsub.
 * Prefer deep imports (`libbitsub/videojs`, `libbitsub/shaka`, `libbitsub/hlsjs`, `libbitsub/react`)
 * so unused peer dependencies stay out of your bundle.
 */

export {
  attachBitSub,
  createBitSubRenderer,
  type AttachBitSubOptions,
  type BitSubController,
  type BitSubRenderer,
  type BitSubSourceOptions
} from './shared'

export {
  registerBitSubPlugin,
  type BitSubVideoJsApi,
  type BitSubVideoJsOptions,
  type VideoJsBitSubPlayer,
  type VideoJsLike,
  type VideoJsPlayerLike
} from './videojs'

export { attachBitSubToShaka, type BitSubShakaHandle, type BitSubShakaOptions, type ShakaPlayerLike } from './shaka'

export { attachBitSubToHls, type BitSubHlsHandle, type BitSubHlsOptions, type HlsLike } from './hlsjs'

export {
  BitSubOverlay,
  useBitSub,
  type BitSubOverlayProps,
  type BitSubReactSource,
  type UseBitSubOptions,
  type UseBitSubResult
} from './react'
