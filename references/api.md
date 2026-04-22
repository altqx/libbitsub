# libbitsub API Reference

## Top-level exports

| Export | Signature | Notes |
|--------|-----------|-------|
| `initWasm` | `() => Promise<void>` | Must be called before any parser or renderer. Safe to call multiple times. |
| `isWasmInitialized` | `() => boolean` | |
| `isWebGPUSupported` | `() => boolean` | |
| `detectSubtitleFormat` | `(source: AutoSubtitleSource) => 'pgs' \| 'vobsub' \| null` | Uses file hints and binary magic bytes, including `.mks` sources carrying embedded `S_VOBSUB` |
| `createAutoSubtitleRenderer` | `(options: AutoVideoSubtitleOptions) => PgsRenderer \| VobSubRenderer` | Throws if format cannot be determined |
| `SubtitleDiagnosticError` | `class extends Error` | Structured diagnostic error with `code`, `format`, and `details` |
| `createSubtitleDiagnosticError` | `(code, message, options?) => SubtitleDiagnosticError` | Create a typed diagnostics error manually |
| `normalizeSubtitleError` | `(error, context?) => SubtitleDiagnosticError` | Map generic errors into stable libbitsub diagnostic codes |

Legacy aliases: `PGSRenderer`, `VobsubRenderer`, `UnifiedSubtitleRenderer`.

---

## `VideoSubtitleOptions`

Accepted by `PgsRenderer` constructor:

```ts
interface VideoSubtitleOptions {
  video: HTMLVideoElement
  subUrl?: string                   // URL to subtitle file
  subContent?: ArrayBuffer          // in-memory subtitle data (alternative to subUrl)
  onLoading?: () => void
  onLoaded?: () => void
  onError?: (error: Error) => void  // libbitsub emits SubtitleDiagnosticError instances here
  onWebGPUFallback?: () => void
  onWebGL2Fallback?: () => void
  displaySettings?: Partial<SubtitleDisplaySettings>
  cacheLimit?: number               // default 24
  prefetchWindow?: { before?: number; after?: number }
  onEvent?: (event: SubtitleRendererEvent) => void
  debug?: boolean
  onWarning?: (warning: SubtitleDiagnosticWarning) => void
  timeOffset?: number
}
```

Low-level parsers accept the same diagnostics subset via:

```ts
interface SubtitleDiagnosticsOptions {
  debug?: boolean
  onWarning?: (warning: SubtitleDiagnosticWarning) => void
}
```

`VideoVobSubOptions` extends `VideoSubtitleOptions` with:
- `idxUrl?: string` — URL to the .idx file (defaults to `subUrl` with `.idx` extension)
- `idxContent?: string` — in-memory .idx content
- `fileName?: string` — file name hint used to classify `.mks` inputs as embedded VobSub sources

`AutoVideoSubtitleOptions` extends `VideoVobSubOptions` with:
- `fileName?: string` — file name hint for format detection

---

## `SubtitleDisplaySettings`

```ts
interface SubtitleDisplaySettings {
  scale: number            // 0.1–3.0, default 1.0
  aspectMode: 'stretch' | 'contain' | 'cover' // default 'stretch'
  verticalOffset: number   // -50 to 50, % of video height; negative = up
  horizontalOffset: number // -50 to 50, % of video width
  horizontalAlign: 'left' | 'center' | 'right'  // default 'center'
  bottomPadding: number    // 0–50, % of video height
  safeArea: number         // 0–25, % of video dimension
  opacity: number          // 0.0–1.0, default 1.0
}
```

`aspectMode` controls how the subtitle track's presentation grid is projected into the visible video box:

- `stretch`: independent X/Y scaling, default behavior.
- `contain`: uniform scaling that keeps subtitle bitmap pixels undistorted inside the box.
- `cover`: uniform scaling that fills the box while preserving subtitle shape. Use this when subtitles were authored for a taller frame than the encoded video, for example `1920x1080` PGS bitmaps over `3840x1600` cropped-scope video.

---

## `PgsRenderer` / `VobSubRenderer`

Both extend `BaseVideoSubtitleRenderer` and expose the same API surface.

### Lifecycle

| Method | Description |
|--------|-------------|
| `dispose(): void` | Release DOM, worker, and parser resources |

### Layout

| Method | Description |
|--------|-------------|
| `setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void` | Merge and apply settings; forces re-render |
| `getDisplaySettings(): SubtitleDisplaySettings` | Returns current settings copy |
| `resetDisplaySettings(): void` | Resets to defaults; forces re-render |

### Cache and prefetch

| Method | Description |
|--------|-------------|
| `setCacheLimit(limit: number): void` | Set max cached decoded frames |
| `getCacheLimit(): number` | |
| `clearFrameCache(): void` | Clears renderer and parser-side frame cache |
| `prefetchRange(startIndex: number, endIndex: number): Promise<void>` | Decode and cache cues by index range |
| `prefetchAroundTime(time: number, before?: number, after?: number): Promise<void>` | Decode cues around a playback time (seconds) |

### Metadata and stats

| Method | Description |
|--------|-------------|
| `getMetadata(): SubtitleParserMetadata \| null` | Track-level: format, cueCount, screenWidth/Height |
| `getCurrentCueMetadata(): SubtitleCueMetadata \| null` | Most recently displayed cue |
| `getCueMetadata(index: number): SubtitleCueMetadata \| null` | Cue by index |
| `getStats(): SubtitleRendererStats` | Performance statistics |
| `getCacheStats(): SubtitleCacheStats` | Cache occupancy, worker readiness, and session diagnostics |
| `getLastRenderInfo(): SubtitleLastRenderInfo \| null` | Last render attempt snapshot, populated when `debug` is enabled |

### VobSubRenderer extras

| Method | Description |
|--------|-------------|
| `setDebandEnabled(enabled: boolean): void` | Enable/disable debanding |
| `setDebandThreshold(value: number): void` | Debanding threshold |
| `setDebandRange(value: number): void` | Debanding range |

`VobSubRenderer` also accepts `.mks` input through `subUrl` or `subContent` when `fileName` or binary inspection identifies an embedded `S_VOBSUB` track. In that case `idxUrl` and `idxContent` are ignored because track metadata is synthesized from the Matroska container.

---

## `PgsParser` (low-level)

```ts
const parser = new PgsParser({ debug: true, onWarning: (warning) => console.warn(warning.code) })
parser.load(data: Uint8Array): number          // returns cue count
parser.getTimestamps(): Float64Array           // timestamps in ms
parser.get count: number                       // display set count
parser.findIndexAtTimestamp(seconds: number): number
parser.renderAtIndex(index: number): SubtitleData | undefined
parser.getMetadata(): SubtitleParserMetadata
parser.getCueMetadata(index: number): SubtitleCueMetadata | null
parser.getLastRenderIssue(): string | null
```

---

## `VobSubParserLowLevel` (low-level)

```ts
const parser = new VobSubParserLowLevel({ debug: true, onWarning: (warning) => console.warn(warning.code) })
parser.loadFromData(idxContent: string, subData: Uint8Array): void
parser.loadFromMks(mksData: Uint8Array): void
parser.setDebandEnabled(enabled: boolean): void
parser.setDebandThreshold(value: number): void
parser.setDebandRange(value: number): void
parser.renderAtTimestamp(seconds: number): SubtitleData | undefined
parser.getCueMetadata(index: number): SubtitleCueMetadata | null
parser.getMetadata(): SubtitleParserMetadata
parser.getLastRenderIssue(): string | null
```

`loadFromMks()` extracts the first embedded `S_VOBSUB` track from a Matroska `.mks` payload, synthesizes equivalent IDX/SUB metadata in memory, and then exposes the same rendering surface as `loadFromData()`.

---

## `UnifiedSubtitleParser` (low-level)

```ts
const parser = new UnifiedSubtitleParser({ debug: true, onWarning: (warning) => console.warn(warning.code) })
parser.loadAuto(source: AutoSubtitleSource): SubtitleFormatName
// source: { data?, subData?, idxContent?, fileName?, subUrl?, idxUrl? }
parser.loadVobSubMks(mksData: Uint8Array): void
parser.getMetadata(): SubtitleParserMetadata
parser.getCueMetadata(index: number): SubtitleCueMetadata | null
parser.getLastRenderIssue(): string | null
```

`loadAuto()` treats `.mks` input as VobSub only for embedded `S_VOBSUB` tracks. `loadVobSubMks()` is the explicit low-level entry point for that path.

Malformed `.mks` payloads are rejected before decode. The extractor validates Matroska structure, bounds decompression, and checks embedded VobSub packet headers for corrupt sizes and control offsets.

---

## Event types (`SubtitleRendererEvent`)

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

### Diagnostics codes

```ts
type SubtitleDiagnosticErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'BAD_IDX'
  | 'MISSING_PALETTE'
  | 'TRACK_NOT_FOUND'
  | 'MISSING_INPUT'
  | 'FETCH_FAILED'
  | 'INVALID_SUBTITLE_DATA'
  | 'WORKER_FALLBACK'
  | 'UNKNOWN'

type SubtitleDiagnosticWarningCode =
  | 'BAD_IDX'
  | 'INVALID_FRAME_DATA'
  | 'INVALID_SUBTITLE_DATA'
  | 'MISSING_PALETTE'
  | 'WORKER_FALLBACK'
```

`SubtitleDiagnosticErrorLike` extends `Error` with `code`, `format?`, `details?`, and `cause?`.

`SubtitleDiagnosticWarning` includes:

```ts
interface SubtitleDiagnosticWarning {
  code: SubtitleDiagnosticWarningCode
  message: string
  format?: SubtitleFormatName
  cueIndex?: number
  details?: Record<string, string | number | boolean | null | undefined>
}
```

### Cache and render diagnostics

```ts
interface SubtitleCacheStats {
  cacheLimit: number
  cachedFrames: number
  pendingRenders: number
  totalEntries: number
  usingWorker: boolean
  workerReady: boolean
  sessionId: string | null
}

interface SubtitleLastRenderInfo {
  time: number
  index: number
  status: 'rendered' | 'cleared' | 'pending' | 'empty' | 'failed'
  backend: 'webgpu' | 'webgl2' | 'canvas2d' | null
  usingWorker: boolean
  cacheHit: boolean
  renderDuration: number
  frameWidth: number | null
  frameHeight: number | null
  compositionCount: number
  cue: SubtitleCueMetadata | null
  cache: SubtitleCacheStats
  capturedAt: number
}
```

---

## `SubtitleCueMetadata`

```ts
interface SubtitleCueMetadata {
  index: number
  format: 'pgs' | 'vobsub'
  startTime: number       // ms
  endTime: number         // ms
  duration: number        // ms
  screenWidth: number
  screenHeight: number
  bounds: { x: number; y: number; width: number; height: number } | null
  compositionCount: number
  paletteId?: number         // PGS only
  compositionState?: number  // PGS only
  language?: string | null   // VobSub only
  trackId?: string | null    // VobSub only
  filePosition?: number      // VobSub only
}
```

---

## `SubtitleRendererStats`

```ts
interface SubtitleRendererStats {
  framesRendered: number
  framesDropped: number
  avgRenderTime: number   // ms
  maxRenderTime: number   // ms
  minRenderTime: number   // ms
  lastRenderTime: number  // ms
  renderFps: number
  usingWorker: boolean
  cachedFrames: number
  pendingRenders: number
  totalEntries: number
  currentIndex: number
}
```

`getLastRenderInfo()` returns `null` until a render attempt has been recorded in `debug` mode.
