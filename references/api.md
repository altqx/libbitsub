# libbitsub API Reference

## Top-level exports

| Export | Signature | Notes |
|--------|-----------|-------|
| `initWasm` | `() => Promise<void>` | Must be called before any parser or renderer. Safe to call multiple times. |
| `isWasmInitialized` | `() => boolean` | |
| `isWebGPUSupported` | `() => boolean` | |
| `isWebGL2Supported` | `() => boolean` | |
| `detectSubtitleFormat` | `(source: AutoSubtitleSource) => 'pgs' \| 'vobsub' \| null` | Uses file hints and binary magic bytes |
| `createAutoSubtitleRenderer` | `(options: AutoVideoSubtitleOptions) => PgsRenderer \| VobSubRenderer` | Throws if format cannot be determined |
| `getWasm` | `() => WasmModule` | Returns initialized WASM module; throws if not yet initialized |
| `getWasmUrl` | `() => string` | Returns absolute URL to `libbitsub_bg.wasm` |

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
  onError?: (error: Error) => void
  onWebGPUFallback?: () => void
  onWebGL2Fallback?: () => void
  displaySettings?: Partial<SubtitleDisplaySettings>
  cacheLimit?: number               // default 24
  prefetchWindow?: { before?: number; after?: number }
  onEvent?: (event: SubtitleRendererEvent) => void
}
```

`VideoVobSubOptions` extends `VideoSubtitleOptions` with:
- `idxUrl?: string` — URL to the .idx file (defaults to `subUrl` with `.idx` extension)
- `idxContent?: string` — in-memory .idx content

`AutoVideoSubtitleOptions` extends `VideoVobSubOptions` with:
- `fileName?: string` — file name hint for format detection

---

## `SubtitleDisplaySettings`

```ts
interface SubtitleDisplaySettings {
  scale: number            // 0.1–3.0, default 1.0
  verticalOffset: number   // -50 to 50, % of video height; negative = up
  horizontalOffset: number // -50 to 50, % of video width
  horizontalAlign: 'left' | 'center' | 'right'  // default 'center'
  bottomPadding: number    // 0–50, % of video height
  safeArea: number         // 0–25, % of video dimension
  opacity: number          // 0.0–1.0, default 1.0
}
```

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

### VobSubRenderer extras

| Method | Description |
|--------|-------------|
| `setDebandEnabled(enabled: boolean): void` | Enable/disable debanding |
| `setDebandThreshold(value: number): void` | Debanding threshold |
| `setDebandRange(value: number): void` | Debanding range |

---

## `PgsParser` (low-level)

```ts
const parser = new PgsParser()
parser.load(data: Uint8Array): number          // returns cue count
parser.getTimestamps(): Float64Array           // timestamps in ms
parser.get count: number                       // display set count
parser.findIndexAtTimestamp(seconds: number): number
parser.renderAtIndex(index: number): SubtitleData | undefined
parser.getMetadata(): SubtitleParserMetadata
parser.getCueMetadata(index: number): SubtitleCueMetadata | null
```

---

## `VobSubParserLowLevel` (low-level)

```ts
const parser = new VobSubParserLowLevel()
parser.loadFromData(idxContent: string, subData: Uint8Array): void
parser.setDebandEnabled(enabled: boolean): void
parser.setDebandThreshold(value: number): void
parser.setDebandRange(value: number): void
parser.renderAtTimestamp(seconds: number): SubtitleData | undefined
parser.getCueMetadata(index: number): SubtitleCueMetadata | null
parser.getMetadata(): SubtitleParserMetadata
```

---

## `UnifiedSubtitleParser` (low-level)

```ts
const parser = new UnifiedSubtitleParser()
parser.loadAuto(source: AutoSubtitleSource): SubtitleFormatName
// source: { data?, subData?, idxContent?, fileName?, subUrl?, idxUrl? }
parser.getMetadata(): SubtitleParserMetadata
parser.getCueMetadata(index: number): SubtitleCueMetadata | null
```

---

## Event types (`SubtitleRendererEvent`)

```ts
type SubtitleRendererEvent =
  | { type: 'loading'; format: SubtitleFormatName }
  | { type: 'loaded'; format: SubtitleFormatName; metadata: SubtitleParserMetadata }
  | { type: 'error'; format: SubtitleFormatName; error: Error }
  | { type: 'renderer-change'; renderer: 'webgpu' | 'webgl2' | 'canvas2d' }
  | { type: 'worker-state'; enabled: boolean; ready: boolean; sessionId: string | null; fallback?: boolean }
  | { type: 'cache-change'; cachedFrames: number; pendingRenders: number; cacheLimit: number }
  | { type: 'cue-change'; cue: SubtitleCueMetadata | null }
  | { type: 'stats'; snapshot: SubtitleRendererStatsSnapshot }
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
