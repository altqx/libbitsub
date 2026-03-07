# libbit(map)sub

High-performance WASM renderer for graphical subtitles (PGS and VobSub), written in Rust.

Started as a fork of Arcus92's [libpgs-js](https://github.com/Arcus92/libpgs-js), this project was reworked for higher performance and broader format support. It keeps the familiar high-level PGS-oriented API while adding a lower-level parser surface, VobSub support, GPU backends, and worker-backed rendering.

## Features

- PGS (Blu-ray) subtitle parsing and rendering
- VobSub (DVD) subtitle parsing and rendering
- WebGPU, WebGL2, and Canvas2D rendering with automatic fallback
- Worker-backed parsing/rendering for large subtitle files
- Rich layout controls: scale, horizontal/vertical offsets, alignment, bottom padding, safe area, opacity
- Cue metadata and parser introspection APIs
- Frame prefetching and cache control for high-level renderers
- Automatic format detection and unified loading helpers
- TypeScript support with exported event and metadata types

## Showcase

### PGS

https://gist.github.com/user-attachments/assets/55ac8e11-1964-4fb9-923e-dcac82dc7703

### VobSub

https://gist.github.com/user-attachments/assets/a89ae9fe-23e4-4bc3-8cad-16a3f0fea665

### Live demo

https://a.rafasu.com/v

## Installation

```bash
npm install libbitsub
# or
bun add libbitsub
```

For JSR:

```bash
deno add jsr:@altq/libbitsub
```

## Worker setup

For best performance, make the generated WASM assets reachable by the browser so the shared worker can load them:

```bash
mkdir -p public/libbitsub
cp node_modules/libbitsub/pkg/libbitsub_bg.wasm public/libbitsub/
cp node_modules/libbitsub/pkg/libbitsub.js public/libbitsub/
```

`workerUrl` still exists in the option type for compatibility, but the current implementation creates an inline shared worker and resolves the WASM asset from the package loader. Supplying `workerUrl` does not change runtime behavior.

## Building from source

Prerequisites:

- Rust
- wasm-pack
- Bun

```bash
cargo install wasm-pack
bun run build
```

## Quick start

Initialize the WASM module once before using any parser or renderer:

```ts
import { initWasm } from 'libbitsub'

await initWasm()
```

## High-level video renderers

The high-level API manages subtitle loading, canvas overlay creation, playback sync, resize handling, worker usage, and renderer fallback.

### PGS renderer

```ts
import { PgsRenderer } from 'libbitsub'

const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  displaySettings: {
    scale: 1.1,
    bottomPadding: 4,
    safeArea: 5
  },
  cacheLimit: 32,
  prefetchWindow: { before: 1, after: 2 },
  onEvent: (event) => {
    if (event.type === 'worker-state') {
      console.log('worker', event.ready ? 'ready' : 'starting', event.sessionId)
    }
  }
})

renderer.dispose()
```

### VobSub renderer

```ts
import { VobSubRenderer } from 'libbitsub'

const renderer = new VobSubRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sub',
  idxUrl: '/subtitles/movie.idx'
})

renderer.setDebandThreshold(64)
renderer.setDebandRange(15)
```

### Automatic format detection

```ts
import { createAutoSubtitleRenderer } from 'libbitsub'

const renderer = createAutoSubtitleRenderer({
  video: videoElement,
  subUrl: '/subtitles/track.sup',
  fileName: 'track.sup'
})
```

Automatic detection uses file hints when available and otherwise inspects the binary payload. If the format cannot be identified confidently, it throws instead of silently forcing a parser.

## Layout controls

Both `PgsRenderer` and `VobSubRenderer` support runtime layout changes:

```ts
renderer.setDisplaySettings({
  scale: 1.2,
  verticalOffset: -8,
  horizontalOffset: 2,
  horizontalAlign: 'center',
  bottomPadding: 6,
  safeArea: 5,
  opacity: 0.92
})

const settings = renderer.getDisplaySettings()
renderer.resetDisplaySettings()
```

`SubtitleDisplaySettings`:

| Field | Type | Range / values | Meaning |
| --- | --- | --- | --- |
| `scale` | number | `0.1` to `3.0` | Overall subtitle scale |
| `verticalOffset` | number | `-50` to `50` | Vertical movement as percent of video height |
| `horizontalOffset` | number | `-50` to `50` | Horizontal movement as percent of video width |
| `horizontalAlign` | `'left' \| 'center' \| 'right'` | fixed set | Anchor used when scaling subtitle groups |
| `bottomPadding` | number | `0` to `50` | Extra padding from the bottom edge |
| `safeArea` | number | `0` to `25` | Clamp subtitles inside a video-safe area |
| `opacity` | number | `0.0` to `1.0` | Global subtitle opacity |

## Metadata and introspection

High-level renderers expose parser and cue metadata:

```ts
const metadata = renderer.getMetadata()
const currentCue = renderer.getCurrentCueMetadata()
const cue42 = renderer.getCueMetadata(42)
```

Low-level parsers expose the same model:

```ts
import { PgsParser, UnifiedSubtitleParser, VobSubParserLowLevel } from 'libbitsub'

const parser = new UnifiedSubtitleParser()
const detected = parser.loadAuto({ data: subtitleBytes, fileName: 'track.sup' })

console.log(detected)
console.log(parser.getMetadata())
console.log(parser.getCueMetadata(0))
```

Metadata includes:

- Track format, cue count, and presentation size
- Cue start/end time and duration
- Rendered cue bounds when available
- PGS composition count, palette ID, composition state
- VobSub language, track ID, IDX metadata presence, file position where available

## Cache control and prefetching

High-level renderers expose cache helpers:

```ts
renderer.setCacheLimit(48)
await renderer.prefetchRange(10, 20)
await renderer.prefetchAroundTime(videoElement.currentTime)
renderer.clearFrameCache()
```

`clearFrameCache()` clears both the renderer-side frame map and the underlying parser cache for the active session.

## Observability events

Use `onEvent` to observe renderer lifecycle and runtime behavior:

```ts
const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  onEvent: (event) => {
    switch (event.type) {
      case 'loading':
      case 'loaded':
      case 'error':
      case 'renderer-change':
      case 'worker-state':
      case 'cache-change':
      case 'cue-change':
      case 'stats':
        console.log(event)
        break
    }
  }
})
```

### Example: event-driven prefetch and cue inspection

```ts
import { PgsRenderer } from 'libbitsub'

const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  prefetchWindow: { before: 1, after: 2 },
  onEvent: async (event) => {
    switch (event.type) {
      case 'loaded': {
        console.log('track metadata', event.metadata)
        await renderer.prefetchAroundTime(videoElement.currentTime)
        break
      }

      case 'cue-change': {
        if (!event.cue) {
          console.log('no active subtitle cue')
          break
        }

        const cue = renderer.getCueMetadata(event.cue.index)
        console.log('active cue', {
          index: cue?.index,
          startTime: cue?.startTime,
          endTime: cue?.endTime,
          bounds: cue?.bounds,
          compositionCount: cue?.compositionCount
        })
        break
      }

      case 'cache-change': {
        console.log('cache', `${event.cachedFrames}/${event.cacheLimit}`, 'pending', event.pendingRenders)
        break
      }
    }
  }
})

videoElement.addEventListener('seeked', () => {
  renderer.prefetchAroundTime(videoElement.currentTime).catch(console.error)
})

// later
renderer.dispose()
```

Emitted events:

| Event | Payload |
| --- | --- |
| `loading` | subtitle format |
| `loaded` | subtitle format and parser metadata |
| `error` | subtitle format and `Error` |
| `renderer-change` | active backend: `webgpu`, `webgl2`, or `canvas2d` |
| `worker-state` | whether worker mode is enabled, ready, fallback status, and the active session ID |
| `cache-change` | cached frame count, pending renders, and configured cache limit |
| `cue-change` | current cue metadata or `null` when nothing is displayed |
| `stats` | periodic renderer stats snapshot |

## Performance stats

```ts
const stats = renderer.getStats()
```

`SubtitleRendererStats` includes:

- `framesRendered`
- `framesDropped`
- `avgRenderTime`
- `maxRenderTime`
- `minRenderTime`
- `lastRenderTime`
- `renderFps`
- `usingWorker`
- `cachedFrames`
- `pendingRenders`
- `totalEntries`
- `currentIndex`

## Low-level APIs

### PGS parser

```ts
import { PgsParser } from 'libbitsub'

const parser = new PgsParser()
parser.load(new Uint8Array(arrayBuffer))

const timestamps = parser.getTimestamps()
const frame = parser.renderAtIndex(0)
const metadata = parser.getMetadata()
```

### VobSub parser

```ts
import { VobSubParserLowLevel } from 'libbitsub'

const parser = new VobSubParserLowLevel()
parser.loadFromData(idxContent, new Uint8Array(subArrayBuffer))
parser.setDebandEnabled(true)

const frame = parser.renderAtTimestamp(120.5)
const cue = parser.getCueMetadata(0)
```

### Unified parser

```ts
import { UnifiedSubtitleParser, detectSubtitleFormat } from 'libbitsub'

const format = detectSubtitleFormat({ data: subtitleBytes, fileName: 'track.sup' })

const parser = new UnifiedSubtitleParser()
parser.loadAuto({ data: subtitleBytes, fileName: 'track.sup' })
```

## GPU backends

libbitsub prefers:

1. WebGPU
2. WebGL2
3. Canvas2D

```ts
import { isWebGL2Supported, isWebGPUSupported } from 'libbitsub'

console.log({
  webgpu: isWebGPUSupported(),
  webgl2: isWebGL2Supported()
})
```

## Notes

- Worker mode is shared, but subtitle parser state is isolated per renderer session.
- Multiple subtitle renderers can coexist without reusing the same parser instance.
- If worker startup fails, the high-level API falls back to main-thread parsing.
- The library only handles bitmap subtitle formats. It does not parse text subtitle formats such as SRT or ASS.

## Low-Level API (Programmatic Use)

For more control over rendering, use the low-level parsers directly.

### PGS Subtitles (Low-Level)

```typescript
import { initWasm, PgsParser } from 'libbitsub'

await initWasm()

const parser = new PgsParser()

// Load PGS data from a .sup file
const response = await fetch('subtitles.sup')
const data = new Uint8Array(await response.arrayBuffer())
parser.load(data)

// Get timestamps
const timestamps = parser.getTimestamps() // Float64Array in milliseconds

// Render at a specific time
const subtitleData = parser.renderAtTimestamp(currentTimeInSeconds)
if (subtitleData) {
  for (const comp of subtitleData.compositionData) {
    ctx.putImageData(comp.pixelData, comp.x, comp.y)
  }
}

// Clean up
parser.dispose()
```

### VobSub Subtitles (Low-Level)

```typescript
import { initWasm, VobSubParserLowLevel } from 'libbitsub'

await initWasm()

const parser = new VobSubParserLowLevel()

// Load from IDX + SUB files
const idxResponse = await fetch('subtitles.idx')
const idxContent = await idxResponse.text()
const subResponse = await fetch('subtitles.sub')
const subData = new Uint8Array(await subResponse.arrayBuffer())

parser.loadFromData(idxContent, subData)

// Or load from SUB file only
// parser.loadFromSubOnly(subData);

// Render
const subtitleData = parser.renderAtTimestamp(currentTimeInSeconds)
if (subtitleData) {
  for (const comp of subtitleData.compositionData) {
    ctx.putImageData(comp.pixelData, comp.x, comp.y)
  }
}

parser.dispose()
```

### Unified Parser

For handling both formats with a single API:

```typescript
import { initWasm, UnifiedSubtitleParser } from 'libbitsub'

await initWasm()

const parser = new UnifiedSubtitleParser()

// Load PGS
parser.loadPgs(pgsData)

// Or load VobSub
// parser.loadVobSub(idxContent, subData);

console.log(parser.format) // 'pgs' or 'vobsub'

const subtitleData = parser.renderAtTimestamp(time)
// ... render to canvas

parser.dispose()
```

## API Reference

### High-Level (Video-Integrated)

#### `PgsRenderer`

- `constructor(options: VideoSubtitleOptions)` - Create video-integrated PGS renderer
- `getDisplaySettings(): SubtitleDisplaySettings` - Get current display settings
- `setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void` - Update display settings
- `resetDisplaySettings(): void` - Reset display settings to defaults
- `getStats(): SubtitleRendererStats` - Get performance statistics
- `dispose(): void` - Clean up all resources

#### `VobSubRenderer`

- `constructor(options: VideoVobSubOptions)` - Create video-integrated VobSub renderer
- `getDisplaySettings(): SubtitleDisplaySettings` - Get current display settings
- `setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void` - Update display settings
- `resetDisplaySettings(): void` - Reset display settings to defaults
- `getStats(): SubtitleRendererStats` - Get performance statistics
- `setDebandEnabled(enabled: boolean): void` - Enable/disable debanding filter
- `setDebandThreshold(threshold: number): void` - Set debanding threshold (0.0-255.0)
- `setDebandRange(range: number): void` - Set debanding sample range (1-64)
- `debandEnabled: boolean` - Check if debanding is enabled
- `dispose(): void` - Clean up all resources

### Low-Level (Programmatic)

#### `PgsParser`

- `load(data: Uint8Array): number` - Load PGS data, returns display set count
- `getTimestamps(): Float64Array` - Get all timestamps in milliseconds
- `count: number` - Number of display sets
- `findIndexAtTimestamp(timeSeconds: number): number` - Find index for timestamp
- `renderAtIndex(index: number): SubtitleData | undefined` - Render at index
- `renderAtTimestamp(timeSeconds: number): SubtitleData | undefined` - Render at time
- `clearCache(): void` - Clear decoded bitmap cache
- `dispose(): void` - Release resources

#### `VobSubParserLowLevel`

- `loadFromData(idxContent: string, subData: Uint8Array): void` - Load IDX + SUB
- `loadFromSubOnly(subData: Uint8Array): void` - Load SUB only
- `setDebandEnabled(enabled: boolean): void` - Enable/disable debanding filter
- `setDebandThreshold(threshold: number): void` - Set debanding threshold (0.0-255.0)
- `setDebandRange(range: number): void` - Set debanding sample range (1-64)
- `debandEnabled: boolean` - Check if debanding is enabled
- Same rendering methods as PgsParser

#### `UnifiedSubtitleParser`

- `loadPgs(data: Uint8Array): number` - Load PGS data
- `loadVobSub(idxContent: string, subData: Uint8Array): void` - Load VobSub
- `loadVobSubOnly(subData: Uint8Array): void` - Load SUB only
- `format: 'pgs' | 'vobsub' | null` - Current format
- Same rendering methods as above

### Types

#### `VideoSubtitleOptions`

```typescript
interface VideoSubtitleOptions {
  video: HTMLVideoElement // Video element to sync with
  subUrl?: string // URL to subtitle file (provide this OR subContent)
  subContent?: ArrayBuffer // Direct subtitle content (provide this OR subUrl)
  workerUrl?: string // Worker URL (for API compatibility)
  onLoading?: () => void // Called when subtitle loading starts
  onLoaded?: () => void // Called when subtitle loading completes
  onError?: (error: Error) => void // Called when subtitle loading fails
  onWebGPUFallback?: () => void // Called when WebGPU init fails
  onWebGL2Fallback?: () => void // Called when WebGL2 init fails
}
```

#### `VideoVobSubOptions`

```typescript
interface VideoVobSubOptions extends VideoSubtitleOptions {
  idxUrl?: string // URL to .idx file (optional, defaults to subUrl with .idx extension)
  idxContent?: string // Direct .idx content (provide this OR idxUrl)
}
```

#### `SubtitleDisplaySettings`

```typescript
interface SubtitleDisplaySettings {
  // Scale factor (1.0 = 100%, 0.5 = 50%, 2.0 = 200%)
  scale: number
  // Vertical offset as % of video height (-50 to 50)
  verticalOffset: number
}
```

#### `SubtitleRendererStats`

```typescript
interface SubtitleRendererStats {
  framesRendered: number // Total frames rendered since initialization
  framesDropped: number // Frames dropped due to slow rendering
  avgRenderTime: number // Average render time in milliseconds
  maxRenderTime: number // Maximum render time in milliseconds
  minRenderTime: number // Minimum render time in milliseconds
  lastRenderTime: number // Last render time in milliseconds
  renderFps: number // Current FPS (renders per second)
  usingWorker: boolean // Whether rendering is using web worker
  cachedFrames: number // Number of cached frames
  pendingRenders: number // Number of pending renders
  totalEntries: number // Total subtitle entries/display sets
  currentIndex: number // Current subtitle index being displayed
}
```

#### `SubtitleData`

```typescript
interface SubtitleData {
  width: number // Screen width
  height: number // Screen height
  compositionData: SubtitleCompositionData[]
}

interface SubtitleCompositionData {
  pixelData: ImageData // RGBA pixel data
  x: number // X position
  y: number // Y position
}
```

## License

MIT
