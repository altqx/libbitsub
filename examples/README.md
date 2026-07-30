# libbitsub player integration recipes

Optional adapters ship with the core package as **subpath exports**. They keep `libbitsub` itself dependency-free: player/React packages are optional peer dependencies and are only required when you import that adapter.

| Integration       | Import                                    | Peer dependency         |
| ----------------- | ----------------------------------------- | ----------------------- |
| Shared controller | `libbitsub/integrations` (`attachBitSub`) | none beyond `libbitsub` |
| Video.js          | `libbitsub/videojs`                       | `video.js` >= 7         |
| Shaka Player      | `libbitsub/shaka`                         | `shaka-player` >= 4     |
| hls.js            | `libbitsub/hlsjs`                         | `hls.js` >= 1           |
| React             | `libbitsub/react`                         | `react` >= 18           |

Bitmap PGS / VobSub / MKS tracks are **not** native HTML text tracks. Each adapter overlays libbitsub on the player's `HTMLVideoElement`.

See the per-player folders for copy-paste recipes:

- [videojs](./videojs)
- [shaka](./shaka)
- [hlsjs](./hlsjs)
- [react](./react)

## Shared controller

```ts
import { attachBitSub } from 'libbitsub/integrations'

const bitsub = attachBitSub(videoElement, {
  subUrl: '/subs/movie.sup',
  displaySettings: { scale: 1.05, bottomPadding: 4 }
})

bitsub.setDisplaySettings({ opacity: 0.9 })
bitsub.load({ subUrl: '/subs/other.sup' })
bitsub.clear()
bitsub.dispose()
```

Prefer deep imports (`libbitsub/videojs`, …) in apps so unused adapters stay out of the bundle graph.
