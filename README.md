# libbit(map)sub

High-performance WASM renderer for graphical subtitles (PGS, VobSub, and MKS-embedded VobSub), written in Rust.

Started as a fork of Arcus92's [libpgs-js](https://github.com/Arcus92/libpgs-js), this project was reworked for higher performance and broader format support. It keeps the familiar high-level PGS-oriented API while adding a lower-level parser surface, VobSub support, GPU backends, and worker-backed rendering.

## Features

- PGS (Blu-ray) subtitle parsing and rendering
- VobSub (DVD) subtitle parsing and rendering
- Matroska `.mks` extraction for embedded `S_VOBSUB` tracks
- WebGPU, WebGL2, and Canvas2D rendering with automatic fallback
- Worker-backed parsing/rendering for large subtitle files
- HTTP Range / streaming loads for large `.sup`, `.sub`, `.idx`, and `.mks` assets (progressive indexing where feasible)
- Rich layout controls: scale, aspect mode, horizontal/vertical offsets, alignment, bottom padding, safe area, opacity
- Cue metadata and parser introspection APIs
- Rendered-frame export helpers for ImageData, ImageBitmap, Blob, and custom canvas targets
- Frame prefetching and cache control for high-level renderers
- Automatic format detection and unified loading helpers
- First-class diagnostics with structured error codes, warning hooks, and render/cache snapshots
- TypeScript support with exported event and metadata types
- Optional player integrations for Video.js, Shaka Player, hls.js, and React (core stays dependency-free)

## Showcase

### PGS

https://gist.github.com/user-attachments/assets/55ac8e11-1964-4fb9-923e-dcac82dc7703

### VobSub

https://gist.github.com/user-attachments/assets/a89ae9fe-23e4-4bc3-8cad-16a3f0fea665

### Live demo

https://a.rafasu.com/v

## Installation

For pure Rust parser/rendering logic:

```toml
[dependencies]
libbitsub-core = "1.10.1"
```

For WASM bindings from Rust:

```toml
[dependencies]
libbitsub = "1.10.1"
```

For JavaScript package managers:

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

In most bundler-based projects, no manual worker setup is required. `libbitsub` now resolves the WASM asset relative to the package module URL, so bundlers such as Vite, webpack, and Rollup can emit the asset automatically.

If your app serves package files in a way that does not expose that emitted WASM asset to the browser, you can still provide the legacy public fallback by copying the WASM file and its JS glue to `/libbitsub/`:

```bash
mkdir -p public/libbitsub
cp node_modules/libbitsub/pkg/libbitsub_bg.wasm node_modules/libbitsub/pkg/libbitsub.js public/libbitsub/
```

The worker is still created inline. `workerUrl` remains in the option type only for compatibility and does not change runtime behavior.

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

The WASM module initializes automatically — high-level renderers call `initWasm()` internally, and importing the library triggers a non-blocking pre-init in browser environments. You can use renderers directly without any setup:

```ts
import { PgsRenderer } from 'libbitsub'

const renderer = new PgsRenderer({ video: videoElement, subUrl: '/subtitles/movie.sup' })
```

For low-level parsers, you can optionally `await initWasm()` to ensure WASM is ready before calling parser methods:

```ts
import { initWasm, PgsParser } from 'libbitsub'

await initWasm()
const parser = new PgsParser()
```

Calling `initWasm()` multiple times is safe (it deduplicates).

### Worker prewarm (TV / players)

On devices where the first subtitle track switch should not pay worker + WASM startup cost (for example TV apps), prewarm the shared parsing worker during app startup:

```ts
import { warmup, ready, PgsRenderer } from 'libbitsub'

// Fire-and-forget at app boot (safe to call multiple times).
void warmup()

// Before the user changes tracks, ensure the worker is ready.
await ready()

const renderer = new PgsRenderer({ video: videoElement, subContent: trackBytes })
```

`warmup()` and `ready()` share a single worker-init promise with renderer creation. The shared worker is only published after in-worker WASM initialization succeeds. When Web Workers are unavailable, both resolve immediately and renderers use the main thread.

### Range / streaming loads (TV / slow networks)

URL-based loads (`subUrl` / `idxUrl`) use progressive fetch by default:

- Probe HTTP Range support and, for large assets, download with Range chunks when the origin allows it
- Stream the response body otherwise and report `load-progress` events
- **PGS (`.sup`)**: feed chunks into the parser as they arrive so cues can be indexed before the full file finishes
- **VobSub (`.idx` + `.sub`)**: parse the small `.idx` first for timestamps, then stream/Range-download the `.sub` body and attach packets
- **MKS**: stream/Range-download the container first (Matroska extraction still needs the assembled payload), then parse
- **In-memory** `subContent` / `idxContent` remains the simple full-buffer path

```ts
import { PgsRenderer } from 'libbitsub'

const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  // streamingLoad: true,  // default
  // rangeRequests: true,  // default
  onEvent: (event) => {
    if (event.type === 'load-progress') {
      console.log(event.strategy, event.loadedBytes, event.totalBytes, event.indexedCues)
    }
    if (event.type === 'indexed') {
      console.log('cues ready', event.metadata.cueCount, event.partial ? '(partial)' : '(final)')
    }
  }
})
```

Disable progressive behavior when you want a single blocking GET:

```ts
new PgsRenderer({ video, subUrl, streamingLoad: false, rangeRequests: false })
```

Low-level helpers are also exported: `probeRangeSupport()`, `fetchSubtitleAsset()`, and `fetchSubtitleText()`.

## Player integrations

Optional adapters ship as **subpath exports**. They wrap the high-level renderers for common players while keeping the core package free of player/React dependencies (peer deps are optional and only needed when you import that adapter).

| Import                   | Adapter                                  | Optional peer       |
| ------------------------ | ---------------------------------------- | ------------------- |
| `libbitsub/videojs`      | Video.js plugin (`registerBitSubPlugin`) | `video.js` >= 7     |
| `libbitsub/shaka`        | `attachBitSubToShaka(player, options)`   | `shaka-player` >= 4 |
| `libbitsub/hlsjs`        | `attachBitSubToHls(hls, options)`        | `hls.js` >= 1       |
| `libbitsub/react`        | `useBitSub` / `BitSubOverlay`            | `react` >= 18       |
| `libbitsub/integrations` | Shared `attachBitSub` controller         | —                   |

Copy-paste recipes live under [`examples/`](./examples).

### Video.js

```ts
import videojs from 'video.js'
import { registerBitSubPlugin } from 'libbitsub/videojs'

registerBitSubPlugin(videojs)
const player = videojs('my-video')
const bitsub = player.bitsub({ subUrl: '/subs/movie.sup' })
bitsub.load({ subUrl: '/subs/other.sup' })
```

### Shaka Player

```ts
import { attachBitSubToShaka } from 'libbitsub/shaka'

const bitsub = attachBitSubToShaka(player, { subUrl: '/subs/movie.sup' })
// later
bitsub.dispose()
```

### hls.js

```ts
import Hls from 'hls.js'
import { attachBitSubToHls } from 'libbitsub/hlsjs'

const hls = new Hls()
hls.loadSource(url)
hls.attachMedia(video)
const bitsub = attachBitSubToHls(hls, { subUrl: '/subs/movie.sup' })
```

### React

```tsx
import { useRef } from 'react'
import { useBitSub } from 'libbitsub/react'

function Player({ src, subUrl }: { src: string; subUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useBitSub(videoRef, { subUrl })
  return (
    <div style={{ position: 'relative' }}>
      <video ref={videoRef} src={src} controls playsInline />
    </div>
  )
}
```

Bitmap PGS/VobSub/MKS tracks are external canvas overlays, not native HTML/TextTrack entries. Prefer deep imports so unused adapters stay out of your bundle.

## High-level video renderers

The high-level API manages subtitle loading, canvas overlay creation, playback sync, resize handling, worker usage, and renderer fallback.

### PGS renderer

```ts
import { PgsRenderer } from 'libbitsub'

const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  debug: true,
  displaySettings: {
    scale: 1.1,
    aspectMode: 'stretch',
    bottomPadding: 4,
    safeArea: 5
  },
  cacheLimit: 32,
  prefetchWindow: { before: 1, after: 2 },
  onWarning: (warning) => {
    console.warn(warning.code, warning.message, warning.details)
  },
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

const mksRenderer = new VobSubRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.mks',
  fileName: 'movie.mks'
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

Automatic detection uses file hints when available and otherwise inspects the binary payload. `.mks` sources are treated as VobSub only when they contain an embedded `S_VOBSUB` track. If the format cannot be identified confidently, it throws instead of silently forcing a parser.

## Layout controls

Both `PgsRenderer` and `VobSubRenderer` support runtime layout changes:

```ts
renderer.setDisplaySettings({
  scale: 1.2,
  aspectMode: 'stretch',
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

`aspectMode` controls how the subtitle track's own presentation size is mapped into the video content box:

- `stretch` default behavior, scales X/Y independently.
- `contain` preserves subtitle bitmap shape and fits the track inside the visible video box.
- `cover` preserves subtitle bitmap shape while filling the video box.

`SubtitleDisplaySettings`:

| Field              | Type                                | Range / values | Meaning                                                        |
| ------------------ | ----------------------------------- | -------------- | -------------------------------------------------------------- |
| `scale`            | number                              | `0.1` to `3.0` | Overall subtitle scale                                         |
| `aspectMode`       | `'stretch' \| 'contain' \| 'cover'` | fixed set      | How subtitle screen coordinates map into the visible video box |
| `verticalOffset`   | number                              | `-50` to `50`  | Vertical movement as percent of video height                   |
| `horizontalOffset` | number                              | `-50` to `50`  | Horizontal movement as percent of video width                  |
| `horizontalAlign`  | `'left' \| 'center' \| 'right'`     | fixed set      | Anchor used when scaling subtitle groups                       |
| `bottomPadding`    | number                              | `0` to `50`    | Extra padding from the bottom edge                             |
| `safeArea`         | number                              | `0` to `25`    | Clamp subtitles inside a video-safe area                       |
| `opacity`          | number                              | `0.0` to `1.0` | Global subtitle opacity                                        |

## Metadata and introspection

High-level renderers expose parser and cue metadata:

```ts
const metadata = renderer.getMetadata()
const currentCue = renderer.getCurrentCueMetadata()
const cue42 = renderer.getCueMetadata(42)
const stats = renderer.getStats()
const cache = renderer.getCacheStats()
const lastRender = renderer.getLastRenderInfo()
```

Low-level parsers expose the same model:

```ts
import { PgsParser, UnifiedSubtitleParser, VobSubParserLowLevel, openSubtitles } from 'libbitsub'

const vob = new VobSubParserLowLevel()
vob.loadFromMks(new Uint8Array(mksBuffer))

const parser = new UnifiedSubtitleParser()
const detected = parser.loadAuto({ data: subtitleBytes, fileName: 'track.mks' })

const opened = await openSubtitles({ data: subtitleBytes, fileName: 'track.mks' })

console.log(detected)
console.log(parser.getMetadata())
console.log(parser.getCueMetadata(0))
console.log(opened.format)
opened.dispose()
```

Metadata includes:

- Track format, cue count, and presentation size
- Cue start/end time and duration
- Rendered cue bounds when available
- PGS composition count, palette ID, composition state
- VobSub language, track ID, IDX metadata presence, file position where available

## One-shot auto API

If you do not care whether the input is PGS or VobSub and only want one stable low-level surface, use `openSubtitles()`.

```ts
import { openSubtitles } from 'libbitsub'

const subtitles = await openSubtitles({
  data: subtitleBytes,
  fileName: 'track.sup'
})

console.log(subtitles.format)
console.log(subtitles.metadata)
console.log(subtitles.timestamps)

const frame = subtitles.renderAtTimestamp(120.5)
const rendered = subtitles.renderFrameDataAtTimestamp(120.5)
const cue = subtitles.getCueMetadata(0)

subtitles.dispose()
```

`openSubtitles()` initializes WASM for you, auto-detects the format, loads the subtitle source, and returns a normalized handle with snapshot properties plus shared low-level helpers such as `renderAtIndex()`, `renderAtTimestamp()`, `renderFrameDataAtIndex()`, `renderFrameDataAtTimestamp()`, `getCueMetadata()`, `getLastRenderIssue()`, `clearCache()`, and `dispose()`.

Like `UnifiedSubtitleParser.loadAuto()`, this is a low-level in-memory API: pass binary subtitle content via `data` or `subData`, and optionally include `fileName`, `idxContent`, `idxUrl`, or `subUrl` as format hints or companion metadata.

## Frame export helpers

Low-level parser output can be flattened into a single exportable frame for previews, editors, snapshots, fixture generation, or visual diffing.

```ts
import { PgsParser, initWasm, renderFrameData, toBlob, toCanvas, toImageBitmap } from 'libbitsub'

await initWasm()

const parser = new PgsParser()
parser.load(new Uint8Array(arrayBuffer))

const subtitleFrame = parser.renderAtTimestamp(120.5)
const rendered = subtitleFrame ? renderFrameData(subtitleFrame, { crop: 'bounds' }) : null

if (rendered) {
  const canvas = toCanvas(rendered)
  const bitmap = await toImageBitmap(rendered)
  const pngBlob = await toBlob(rendered)

  console.log({
    width: rendered.imageData.width,
    height: rendered.imageData.height,
    offsetX: rendered.offsetX,
    offsetY: rendered.offsetY,
    bounds: rendered.bounds,
    canvas,
    bitmap,
    pngBlob
  })
}
```

Parser convenience methods avoid the extra `renderAtTimestamp()` step:

```ts
const rendered = parser.renderFrameDataAtTimestamp(120.5)
const fullScreenFrame = parser.renderFrameDataAtIndex(42, { crop: 'screen' })
```

Cropping modes:

- `bounds` is the default. It returns a tightly cropped composed image and records where that image belongs in the original subtitle presentation area via `offsetX` and `offsetY`.
- `screen` preserves the full subtitle presentation dimensions, which is useful when you need stable frame sizes for test fixtures or when drawing into a presentation-sized surface.

Drawing behavior:

- `toCanvas(frame)` creates a new canvas sized to the rendered export.
- Passing an existing canvas target resizes it by default before drawing.
- Passing an existing 2D context draws in place by default, which is useful when you want subtitles composited into your own pre-sized surface.

## Diagnostics mode

Enable `debug: true` on high-level renderers when you need richer field diagnostics for malformed subtitle files. In debug mode, libbitsub records the most recent render attempt and emits structured warnings in addition to the existing lifecycle events.

```ts
import { PgsRenderer, SubtitleDiagnosticError } from 'libbitsub'

const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  debug: true,
  onWarning: (warning) => {
    console.warn('[warning]', warning.code, warning.message, warning.details)
  },
  onError: (error) => {
    if (error instanceof SubtitleDiagnosticError) {
      console.error('[error]', error.code, error.message, error.details)
      return
    }

    console.error(error)
  }
})

console.log(renderer.getStats())
console.log(renderer.getCacheStats())
console.log(renderer.getLastRenderInfo())
```

Structured diagnostic error codes currently include:

- `UNSUPPORTED_FORMAT`
- `BAD_IDX`
- `MISSING_PALETTE`
- `TRACK_NOT_FOUND`
- `MISSING_INPUT`
- `FETCH_FAILED`
- `INVALID_SUBTITLE_DATA`
- `WORKER_FALLBACK`
- `UNKNOWN`

Warnings use a smaller code set focused on non-fatal conditions such as malformed bitmap buffers, worker fallback, progressive/Range fallback (`RANGE_FALLBACK`), and missing PGS palettes during render.

## MKS security and corruption checks

The `.mks` path validates Matroska structure before handing payloads to the VobSub decoder. Embedded subtitle blocks are size-checked, compressed blocks use bounded zlib inflation, and extracted SPU packets are rejected if their declared payload lengths or control offsets are inconsistent. Malformed or oversized `.mks` payloads fail fast instead of being partially decoded.

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
      case 'load-progress':
      case 'indexed':
      case 'loaded':
      case 'error':
      case 'warning':
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

| Event             | Payload                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `loading`         | subtitle format                                                                   |
| `loaded`          | subtitle format and parser metadata                                               |
| `error`           | subtitle format and `SubtitleDiagnosticErrorLike`                                 |
| `warning`         | `SubtitleDiagnosticWarning`                                                       |
| `renderer-change` | active backend: `webgpu`, `webgl2`, or `canvas2d`                                 |
| `worker-state`    | whether worker mode is enabled, ready, fallback status, and the active session ID |
| `cache-change`    | cached frame count, pending renders, and configured cache limit                   |
| `cue-change`      | current cue metadata or `null` when nothing is displayed                          |
| `stats`           | periodic renderer stats snapshot                                                  |

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

`getCacheStats()` adds worker/session state for the current renderer cache, while `getLastRenderInfo()` exposes the most recent render outcome with a status of `rendered`, `cleared`, `pending`, `empty`, or `failed`.

## Low-level APIs

### PGS parser

```ts
import { PgsParser } from 'libbitsub'

const parser = new PgsParser()
parser.load(new Uint8Array(arrayBuffer))

const timestamps = parser.getTimestamps()
const frame = parser.renderAtIndex(0)
const rendered = parser.renderFrameDataAtTimestamp(120.5)
const metadata = parser.getMetadata()
const lastIssue = parser.getLastRenderIssue()
```

### VobSub parser

```ts
import { VobSubParserLowLevel } from 'libbitsub'

const parser = new VobSubParserLowLevel()
parser.loadFromData(idxContent, new Uint8Array(subArrayBuffer))
parser.setDebandEnabled(true)

const frame = parser.renderAtTimestamp(120.5)
const rendered = parser.renderFrameDataAtIndex(0, { crop: 'screen' })
const cue = parser.getCueMetadata(0)
const lastIssue = parser.getLastRenderIssue()
```

### Unified parser

```ts
import { UnifiedSubtitleParser, detectSubtitleFormat } from 'libbitsub'

const format = detectSubtitleFormat({ data: subtitleBytes, fileName: 'track.sup' })

const parser = new UnifiedSubtitleParser({
  debug: true,
  onWarning: (warning) => console.warn(warning.code, warning.message)
})
parser.loadAuto({ data: subtitleBytes, fileName: 'track.sup' })
```

## GPU backends

libbitsub prefers:

1. WebGPU
2. WebGL2
3. Canvas2D

```ts
import { isWebGPUSupported } from 'libbitsub'

console.log({
  webgpu: isWebGPUSupported()
})
```

WebGL2 and Canvas2D fallback remain automatic. Use `onWebGPUFallback`, `onWebGL2Fallback`, `onEvent`, or `onWarning` if you need to observe backend changes.

## Compatibility & visual regression

A formal suite locks decoder edge cases and backend pixel parity:

- Malformed PGS / VobSub / MKS fixtures
- Palette edge cases and zero-length RLE runs
- Alternate display sizes (SD → 4K)
- Slow worker startup / shared init
- Pixel-level goldens across software, Canvas2D, WebGL2, and WebGPU

```bash
bun run test        # Rust core (includes compatibility fixtures)
bun run test:ts     # TypeScript fixtures, goldens, worker startup
bun run test:visual # Headless Chromium backend parity
bun run test:all    # All of the above
```

Browser/device support matrix (including webOS TV): [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).

## Notes

- Worker mode is shared, but subtitle parser state is isolated per renderer session.
- Multiple subtitle renderers can coexist without reusing the same parser instance.
- If worker startup fails, the high-level API falls back to main-thread parsing and emits a `WORKER_FALLBACK` warning/event when diagnostics are being observed.
- The library only handles bitmap subtitle formats. It does not parse text subtitle formats such as SRT or ASS.

## API Reference

### Top-level exports

- `initWasm(): Promise<void>` initializes the WASM module. Called automatically by high-level renderers and on first import in browser environments. Safe to call multiple times. Only needed explicitly for low-level parser usage.
- `isWasmInitialized(): boolean` reports whether initialization has completed.
- `warmup(): Promise<void>` / `ready(): Promise<void>` pre-initialize the shared subtitle worker (including in-worker WASM). Safe to call multiple times; concurrent callers share one init promise. Prefer these in TV/player apps before the first track switch.
- `isWorkerAvailable(): boolean` / `isWorkerReady(): boolean` report worker support and whether the shared worker has finished initializing.
- `isWebGPUSupported(): boolean` checks WebGPU support.
- `detectSubtitleFormat(source: AutoSubtitleSource): 'pgs' | 'vobsub' | null` detects the bitmap subtitle format from file hints or binary data.
- `createAutoSubtitleRenderer(options: AutoVideoSubtitleOptions): PgsRenderer | VobSubRenderer` creates a high-level renderer after format detection.
- `openSubtitles(source, options?): Promise<OpenedSubtitles>` initializes WASM, auto-detects the low-level format, and returns a normalized parser handle.
- `probeRangeSupport(url, options?)` / `fetchSubtitleAsset(url, options?, onChunk?)` / `fetchSubtitleText(url, options?)` perform Range-aware progressive asset downloads for custom loaders.
- `renderFrameData(frame, options?): SubtitleRenderedFrameData | null` composes a `SubtitleData` frame into exportable pixels.
- `toCanvas(frame, target?, options?): HTMLCanvasElement | OffscreenCanvas` draws a rendered frame to a new or existing canvas/context.
- `toImageBitmap(frame, options?): Promise<ImageBitmap>` creates an `ImageBitmap` from a subtitle frame export.
- `toBlob(frame, type?, quality?, options?): Promise<Blob>` encodes a subtitle frame export, defaulting to PNG.
- `SubtitleDiagnosticError` is the structured error class libbitsub uses for coded diagnostics.
- `createSubtitleDiagnosticError(...)` and `normalizeSubtitleError(...)` are exported for integrations that want to preserve libbitsub-style error codes.
- Legacy aliases remain exported: `PGSRenderer`, `VobsubRenderer`, `UnifiedSubtitleRenderer`.
- Optional integration entry points: `libbitsub/videojs`, `libbitsub/shaka`, `libbitsub/hlsjs`, `libbitsub/react`, `libbitsub/integrations` (see [examples/](./examples) and [references/api.md](./references/api.md)).

### High-level renderers

#### `PgsRenderer`

- `constructor(options: VideoSubtitleOptions)` creates a video-synced PGS renderer.
- `getDisplaySettings(): SubtitleDisplaySettings` returns the current layout settings.
- `setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void` updates layout settings.
- `resetDisplaySettings(): void` resets layout settings to defaults.
- `getStats(): SubtitleRendererStats` returns render statistics.
- `getCacheStats(): SubtitleCacheStats` returns cache occupancy, worker readiness, and session ID details.
- `getLastRenderInfo(): SubtitleLastRenderInfo | null` returns the last render attempt recorded in debug mode.
- `getMetadata(): SubtitleParserMetadata | null` returns track-level metadata.
- `getCurrentCueMetadata(): SubtitleCueMetadata | null` returns the currently displayed cue metadata.
- `getCueMetadata(index: number): SubtitleCueMetadata | null` returns metadata for a specific cue.
- `getCacheLimit(): number` returns the active frame-cache limit.
- `setCacheLimit(limit: number): void` updates the frame-cache limit.
- `clearFrameCache(): void` clears the renderer-side and parser-side frame cache.
- `prefetchRange(startIndex: number, endIndex: number): Promise<void>` prefetches decoded frames for a cue range.
- `prefetchAroundTime(time: number, before?: number, after?: number): Promise<void>` prefetches around a playback time in seconds.
- `dispose(): void` releases DOM, parser, and worker resources.

#### `VobSubRenderer`

- Supports all `PgsRenderer` methods above.
- `setDebandEnabled(enabled: boolean): void` enables or disables debanding.
- `setDebandThreshold(threshold: number): void` updates the deband threshold.
- `setDebandRange(range: number): void` updates the deband sample range.
- `debandEnabled: boolean` reports whether debanding is enabled.

### Low-level parsers

#### `PgsParser`

- `load(data: Uint8Array): number` loads PGS data and returns the cue count (simple in-memory path).
- `reset(): void` / `feed(data: Uint8Array): number` / `finishFeed(): number` progressive indexing APIs for streamed chunks.
- `pendingLen: number` incomplete trailing bytes retained between `feed()` calls.
- `getTimestamps(): Float64Array` returns cue timestamps in milliseconds.
- `count: number` returns the number of cues.
- `findIndexAtTimestamp(timeSeconds: number): number` finds the cue index for a playback time in seconds.
- `renderAtIndex(index: number): SubtitleData | undefined` renders a cue by index.
- `renderAtTimestamp(timeSeconds: number): SubtitleData | undefined` renders a cue at a playback time.
- `getMetadata(): SubtitleParserMetadata` returns parser metadata.
- `getCueMetadata(index: number): SubtitleCueMetadata | null` returns cue metadata.
- `clearCache(): void` clears parser-side caches.
- `dispose(): void` frees parser resources.

#### `VobSubParserLowLevel`

- `loadFromData(idxContent: string, subData: Uint8Array): void` loads IDX and SUB data (simple in-memory path).
- `loadFromIdx(idxContent: string): void` indexes timestamps from IDX before packet bytes arrive.
- `attachSubData(subData: Uint8Array): void` attaches `.sub` packets after an IDX-first load.
- `hasSubData: boolean` whether packet bytes are currently attached.
- `loadFromSubOnly(subData: Uint8Array): void` loads SUB-only VobSub data.
- `getTimestamps(): Float64Array`, `count`, `findIndexAtTimestamp()`, `renderAtIndex()`, `renderAtTimestamp()`, `getMetadata()`, `getCueMetadata()`, `clearCache()`, and `dispose()` behave like `PgsParser`.
- `setDebandEnabled(enabled: boolean): void`, `setDebandThreshold(threshold: number): void`, `setDebandRange(range: number): void`, and `debandEnabled` control debanding.

#### `UnifiedSubtitleParser`

- `loadPgs(data: Uint8Array): number` loads PGS data.
- `loadVobSub(idxContent: string, subData: Uint8Array): void` loads VobSub from IDX and SUB.
- `loadVobSubOnly(subData: Uint8Array): void` loads SUB-only VobSub data.
- `loadAuto(source: AutoSubtitleSource): SubtitleFormatName` detects and loads a supported bitmap subtitle format.
- `format: 'pgs' | 'vobsub' | null` returns the active format.
- `getTimestamps()`, `count`, `findIndexAtTimestamp()`, `renderAtIndex()`, `renderAtTimestamp()`, `getMetadata()`, `getCueMetadata()`, `clearCache()`, and `dispose()` are available as on the format-specific parsers.

### Core option and data types

#### `VideoSubtitleOptions`

```ts
interface VideoSubtitleOptions {
  video: HTMLVideoElement
  subUrl?: string
  subContent?: ArrayBuffer
  workerUrl?: string
  onLoading?: () => void
  onLoaded?: () => void
  onError?: (error: Error) => void
  onWebGPUFallback?: () => void
  onWebGL2Fallback?: () => void
  displaySettings?: Partial<SubtitleDisplaySettings>
  cacheLimit?: number
  prefetchWindow?: {
    before?: number
    after?: number
  }
  streamingLoad?: boolean // default true — progressive URL loads
  rangeRequests?: boolean // default true — use HTTP Range when supported
  onEvent?: (event: SubtitleRendererEvent) => void
}
```

#### `VideoVobSubOptions`

```ts
interface VideoVobSubOptions extends VideoSubtitleOptions {
  idxUrl?: string
  idxContent?: string
}
```

#### `AutoVideoSubtitleOptions`

```ts
interface AutoVideoSubtitleOptions extends Omit<VideoVobSubOptions, 'subUrl' | 'idxUrl'> {
  subUrl?: string
  idxUrl?: string
  fileName?: string
}
```

#### `SubtitleDisplaySettings`

```ts
interface SubtitleDisplaySettings {
  scale: number
  aspectMode: 'stretch' | 'contain' | 'cover'
  verticalOffset: number
  horizontalOffset: number
  horizontalAlign: 'left' | 'center' | 'right'
  bottomPadding: number
  safeArea: number
  opacity: number
}
```

#### `SubtitleRendererEvent`

```ts
type SubtitleRendererEvent =
  | { type: 'loading'; format: SubtitleFormatName }
  | { type: 'loaded'; format: SubtitleFormatName; metadata: SubtitleParserMetadata }
  | { type: 'error'; format: SubtitleFormatName; error: SubtitleDiagnosticErrorLike }
  | { type: 'warning'; warning: SubtitleDiagnosticWarning }
  | { type: 'renderer-change'; renderer: 'webgpu' | 'webgl2' | 'canvas2d' }
  | { type: 'worker-state'; enabled: boolean; ready: boolean; sessionId: string | null; fallback?: boolean }
  | { type: 'cache-change'; cachedFrames: number; pendingRenders: number; cacheLimit: number }
  | { type: 'cue-change'; cue: SubtitleCueMetadata | null }
  | { type: 'stats'; stats: SubtitleRendererStatsSnapshot }
```

#### `SubtitleRendererStats` and `SubtitleRendererStatsSnapshot`

Both shapes expose:

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

Related diagnostics shapes:

- `SubtitleCacheStats` from `getCacheStats()`.
- `SubtitleLastRenderInfo` from `getLastRenderInfo()` when `debug` is enabled.

#### `SubtitleParserMetadata`

```ts
interface SubtitleParserMetadata {
  format: 'pgs' | 'vobsub'
  cueCount: number
  screenWidth: number
  screenHeight: number
  language?: string | null
  trackId?: string | null
  hasIdxMetadata?: boolean
}
```

#### `SubtitleCueMetadata`

```ts
interface SubtitleCueMetadata {
  index: number
  format: 'pgs' | 'vobsub'
  startTime: number
  endTime: number
  duration: number
  screenWidth: number
  screenHeight: number
  bounds: SubtitleCueBounds | null
  compositionCount: number
  paletteId?: number
  compositionState?: number
  language?: string | null
  trackId?: string | null
  filePosition?: number
}
```

#### `AutoSubtitleSource`

```ts
interface AutoSubtitleSource {
  data?: ArrayBuffer | Uint8Array
  subData?: ArrayBuffer | Uint8Array
  idxContent?: string
  fileName?: string
  subUrl?: string
  idxUrl?: string
}
```

#### `SubtitleData`

```ts
interface SubtitleData {
  width: number
  height: number
  compositionData: SubtitleCompositionData[]
}

interface SubtitleCompositionData {
  pixelData: ImageData
  x: number
  y: number
}
```

## License

MIT
