# Video.js + libbitsub

## Install

```bash
npm install libbitsub video.js
```

## Recipe

```ts
import videojs from 'video.js'
import 'video.js/dist/video-js.css'
import { registerBitSubPlugin } from 'libbitsub/videojs'

registerBitSubPlugin(videojs)

const player = videojs('my-video', {
  controls: true,
  sources: [{ src: '/media/movie.mp4', type: 'video/mp4' }]
})

// Autoload a PGS track when the plugin starts:
const bitsub = player.bitsub({
  subUrl: '/subs/movie.sup',
  displaySettings: { aspectMode: 'cover', bottomPadding: 6 },
  onEvent: (event) => console.log('bitsub', event)
})

// Or load later (e.g. after the user picks a language):
bitsub.load({
  subUrl: '/subs/movie.eng.sup',
  fileName: 'movie.eng.sup'
})

bitsub.setDisplaySettings({ scale: 1.1 })
bitsub.clear()

// Plugin resources are released with the player:
// player.dispose()
```

## HTML sketch

```html
<video id="my-video" class="video-js vjs-big-play-centered" playsinline></video>
```

Ensure the player container can host an absolutely positioned canvas (Video.js already uses non-static positioning on its root).

## Notes

- Resolves the tech `<video>` element via `player.tech(true)` with a DOM fallback.
- Rebinds on `loadeddata` if the tech element is replaced.
- Emits `bitsubload` / `bitsubclear` on the player for light app wiring.
