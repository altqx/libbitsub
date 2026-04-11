---
name: libbitsub
description: Integration guide for libbitsub — a WASM-based high-performance bitmap subtitle renderer (PGS, VobSub, and MKS-embedded VobSub) for the browser. Use when adding graphical subtitle support to a video player, integrating PGS (.sup), VobSub (.sub/.idx), or `.mks` files carrying embedded `S_VOBSUB`, configuring layout controls (scale, aspect mode, offset, opacity), or using the low-level parser APIs.
---

# libbitsub Integration

libbitsub is a Rust/WASM-powered bitmap subtitle renderer for PGS (Blu-ray .sup), VobSub (DVD .sub/.idx), and Matroska `.mks` files with embedded `S_VOBSUB` tracks. It manages canvas overlay, video sync, resize, worker offloading, and GPU rendering automatically.

## Installation

```bash
npm install libbitsub
# bun add libbitsub / deno add jsr:@altq/libbitsub
```

In most bundler-based projects, no manual worker setup is required. `libbitsub` now resolves the WASM asset relative to the package module URL, so bundlers such as Vite, webpack, and Rollup can emit the asset automatically.

If your app serves package files in a way that does not expose that emitted WASM asset to the browser, you can still provide the legacy public fallback by copying the WASM file to `/libbitsub/libbitsub_bg.wasm`:

```bash
mkdir -p public/libbitsub
cp node_modules/libbitsub/pkg/libbitsub_bg.wasm public/libbitsub/
```

The worker is still created inline. `workerUrl` remains in the option type only for compatibility and does not change runtime behavior.

## WASM initialization

The WASM module initializes automatically — high-level renderers (`PgsRenderer`, `VobSubRenderer`) call `initWasm()` internally, and the module also triggers a non-blocking pre-init on first import in browser environments. No explicit initialization is needed for renderer usage.

For low-level parsers (`PgsParser`, `VobSubParserLowLevel`), await `initWasm()` before calling parser methods:

```ts
import { initWasm, PgsParser } from 'libbitsub'
await initWasm()
const parser = new PgsParser()
```

Calling `initWasm()` multiple times is safe (it deduplicates).

## High-level video renderers

These attach a canvas overlay to the video's parent, handle playback sync, resize, and use a shared Web Worker + GPU rendering automatically.

**Requirement**: the video's parent element must be `position: relative` (or similar non-static). The renderer sets this automatically if it detects `position: static`.

### PGS

```ts
import { PgsRenderer } from 'libbitsub'

const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  // or pass subContent: arrayBuffer for in-memory data
  displaySettings: { scale: 1.1, aspectMode: 'stretch', bottomPadding: 4, safeArea: 5 },
  cacheLimit: 32,
  prefetchWindow: { before: 1, after: 2 },
  onLoading: () => setLoading(true),
  onLoaded: () => setLoading(false),
  onError: (err) => console.error(err),
  onEvent: (event) => console.log(event)
})

// later
renderer.dispose()
```

### VobSub

```ts
import { VobSubRenderer } from 'libbitsub'

const renderer = new VobSubRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sub',
  idxUrl: '/subtitles/movie.idx' // optional, defaults to subUrl with .idx extension
})

const mksRenderer = new VobSubRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.mks',
  fileName: 'movie.mks'
})

renderer.setDebandEnabled(true)
renderer.setDebandThreshold(64)
renderer.setDebandRange(15)
renderer.dispose()
```

### Auto-detect format

```ts
import { createAutoSubtitleRenderer } from 'libbitsub'

const renderer = createAutoSubtitleRenderer({
  video: videoElement,
  subUrl: '/subtitles/track.sup',
  fileName: 'track.sup' // file hint for detection
})
```

Detection uses file extension + binary magic bytes. `.mks` sources resolve to VobSub only when they contain an embedded `S_VOBSUB` track. Throws if format cannot be determined.

## Layout controls

Apply at construction via `displaySettings` or at runtime:

```ts
renderer.setDisplaySettings({
  scale: 1.2,            // 0.1–3.0
  aspectMode: 'cover',   // 'stretch' | 'contain' | 'cover'
  verticalOffset: -8,    // -50 to 50, % of video height (negative = up)
  horizontalOffset: 2,   // -50 to 50, % of video width
  horizontalAlign: 'center', // 'left' | 'center' | 'right'
  bottomPadding: 6,      // 0–50, % of video height
  safeArea: 5,           // 0–25, % of video dimension
  opacity: 0.92          // 0.0–1.0
})

renderer.getDisplaySettings()
renderer.resetDisplaySettings()
```

`aspectMode` controls how the subtitle track's presentation size is mapped into the visible video box:

- `stretch`: default behavior, scales X/Y independently.
- `contain`: preserves subtitle bitmap shape and fits the subtitle grid inside the visible video box.
- `cover`: preserves subtitle bitmap shape while filling the visible video box. This is the recommended mode when subtitles were authored for a taller frame, such as `1920x1080`, but the encoded video has cropped black bars, such as `3840x1600`.

## Cache and prefetch

```ts
renderer.setCacheLimit(48)
await renderer.prefetchRange(10, 20)
await renderer.prefetchAroundTime(video.currentTime) // seconds
renderer.clearFrameCache()
```

Prefetch around seek events for smoother playback:

```ts
video.addEventListener('seeked', () => renderer.prefetchAroundTime(video.currentTime))
```

## Observability events

```ts
new PgsRenderer({
  video,
  subUrl,
  onEvent: (event) => {
    switch (event.type) {
      case 'loading':        // format starting to load
      case 'loaded':         // { format, metadata } ready
      case 'error':          // { format, error }
      case 'renderer-change':// { renderer: 'webgpu' | 'webgl2' | 'canvas2d' }
      case 'worker-state':   // { enabled, ready, sessionId, fallback? }
      case 'cache-change':   // { cachedFrames, pendingRenders, cacheLimit }
      case 'cue-change':     // { cue: SubtitleCueMetadata | null }
      case 'stats':          // periodic performance snapshot
    }
  }
})
```

Use `cue-change` to track what subtitle is active; use `loaded` to kick off prefetching.

## Metadata inspection

```ts
renderer.getMetadata()           // track-level: format, cueCount, screenWidth, screenHeight
renderer.getCurrentCueMetadata() // currently displayed cue
renderer.getCueMetadata(42)      // specific cue by index
renderer.getStats()              // framesRendered, avgRenderTime, usingWorker, etc.
```

## Low-level parsers

Use when you need programmatic access to subtitle data without video integration.

```ts
import { initWasm, PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser } from 'libbitsub'

await initWasm()

// PGS
const pgs = new PgsParser()
pgs.load(new Uint8Array(arrayBuffer))
const frame = pgs.renderAtIndex(pgs.findIndexAtTimestamp(120.5))
const meta = pgs.getMetadata()

// VobSub
const vob = new VobSubParserLowLevel()
vob.loadFromData(idxString, new Uint8Array(subBuffer))
vob.setDebandEnabled(true)
const frame2 = vob.renderAtTimestamp(120.5)

// MKS with embedded S_VOBSUB
const mksVob = new VobSubParserLowLevel()
mksVob.loadFromMks(new Uint8Array(mksBuffer))

// Unified auto-detect
const parser = new UnifiedSubtitleParser()
const detected = parser.loadAuto({ data: subtitleBytes, fileName: 'track.sup' })
```

## GPU backends

libbitsub prefers WebGPU → WebGL2 → Canvas2D, with automatic fallback:

```ts
import { isWebGPUSupported, isWebGL2Supported } from 'libbitsub'

new PgsRenderer({
  video,
  subUrl,
  onWebGPUFallback: () => console.warn('WebGPU unavailable, using WebGL2'),
  onWebGL2Fallback: () => console.warn('WebGL2 unavailable, using Canvas2D')
})
```

## Key constraints

- Bitmap subtitles only (PGS, VobSub, and `.mks` files carrying embedded `S_VOBSUB`). Does **not** handle SRT, ASS, or any text-based formats.
- `.mks` support is limited to embedded `S_VOBSUB` tracks. It is not a general Matroska subtitle parser.
- Multiple renderers can coexist; each has its own isolated parser session.
- If the shared worker fails to start, the API silently falls back to main-thread rendering.
- `dispose()` must be called when removing a renderer to release DOM nodes, parser memory, and worker sessions.

## Full API reference

See [references/api.md](references/api.md) for the complete method signatures of all classes and top-level exports.
