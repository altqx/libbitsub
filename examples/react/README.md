# React + libbitsub

## Install

```bash
npm install libbitsub react react-dom
```

## Hook recipe

```tsx
import { useRef } from 'react'
import { useBitSub } from 'libbitsub/react'

export function VideoWithBitmaps({ src, subUrl }: { src: string; subUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const { error } = useBitSub(videoRef, {
    subUrl,
    fileName: subUrl,
    displaySettings: { scale: 1.05, bottomPadding: 4 },
    onEvent: (event) => {
      if (event.type === 'cue-change') {
        console.log('cue', event.cue)
      }
    }
  })

  return (
    <div style={{ position: 'relative' }}>
      <video ref={videoRef} src={src} controls playsInline style={{ width: '100%' }} />
      {error ? <p role='alert'>{error.message}</p> : null}
    </div>
  )
}
```

## Overlay component recipe

```tsx
import { useRef } from 'react'
import { BitSubOverlay } from 'libbitsub/react'

export function Player({ src, subUrl }: { src: string; subUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  return (
    <div style={{ position: 'relative' }}>
      <video ref={videoRef} src={src} controls playsInline />
      <BitSubOverlay videoRef={videoRef} subUrl={subUrl} displaySettings={{ aspectMode: 'cover' }} />
    </div>
  )
}
```

## Notes

- Prefer **either** `useBitSub` **or** `BitSubOverlay` on the same video — not both.
- Parent should be non-static (`relative` is enough) so the canvas overlay can position correctly.
- Changing `subUrl` / content identity disposes and recreates the renderer; layout-only `displaySettings` updates are applied in place.
- Call sites that need imperative control can read `controller` from `useBitSub` (`load`, `clear`, `setDisplaySettings`).
