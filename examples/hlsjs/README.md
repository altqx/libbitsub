# hls.js + libbitsub

## Install

```bash
npm install libbitsub hls.js
```

## Recipe

```ts
import Hls from 'hls.js'
import { attachBitSubToHls } from 'libbitsub/hlsjs'

const video = document.getElementById('video') as HTMLVideoElement
const hls = new Hls()

hls.loadSource('/media/master.m3u8')
hls.attachMedia(video)

// Can be created before or after attachMedia().
const bitsub = attachBitSubToHls(hls, {
  subUrl: '/subs/movie.sup',
  displaySettings: { aspectMode: 'contain' },
  onEvent: (event) => {
    if (event.type === 'loaded') {
      console.log('bitmap track ready', event.metadata)
    }
  }
})

// Runtime swap:
bitsub.load({ subUrl: '/subs/commentary.sup', fileName: 'commentary.sup' })
bitsub.clear()

// Cleanup (also runs if hls.destroy() fires DESTROYING)
bitsub.dispose()
hls.destroy()
```

## HTML sketch

```html
<div style="position: relative">
  <video id="video" controls playsinline></video>
</div>
```

## Notes

- Binds to `hls.media` and re-attaches on `MEDIA_ATTACHED`.
- Clears on `MEDIA_DETACHED` and disposes on `DESTROYING`.
- hls.js continues to own HLS text tracks (WebVTT, etc.); libbitsub only draws external bitmap overlays.
