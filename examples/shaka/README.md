# Shaka Player + libbitsub

## Install

```bash
npm install libbitsub shaka-player
```

## Recipe

```ts
import shaka from 'shaka-player'
import { attachBitSubToShaka } from 'libbitsub/shaka'

shaka.polyfill.installAll()

const video = document.getElementById('video') as HTMLVideoElement
const player = new shaka.Player()
await player.attach(video)
await player.load('/media/manifest.mpd')

// Bitmap tracks are external overlays (not Shaka TextTrack objects).
const bitsub = attachBitSubToShaka(player, {
  subUrl: '/subs/movie.sup',
  prefetchWindow: { before: 1, after: 2 },
  onError: (error) => console.error(error)
})

// Switch tracks at runtime:
bitsub.load({
  subUrl: '/subs/movie.idx', // companion .sub inferred / provide subUrl to .sub
  idxUrl: '/subs/movie.idx',
  fileName: 'movie.sub'
})

// Prefer explicit VobSub pair:
bitsub.load({
  subUrl: '/subs/movie.sub',
  idxUrl: '/subs/movie.idx'
})

bitsub.setDisplaySettings({ safeArea: 5, opacity: 0.95 })

// Cleanup
bitsub.dispose()
await player.destroy()
```

## HTML sketch

```html
<div style="position: relative">
  <video id="video" controls playsinline></video>
</div>
```

## Notes

- Uses `player.getMediaElement()` and requires an `HTMLVideoElement`.
- Listens for Shaka `loaded` / `unloading` when available to rebind or clear.
- Keep using Shaka's native text pipeline for WebVTT/TTML; use libbitsub only for PGS/VobSub/MKS bitmaps.
