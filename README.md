# libbit(map)sub

High-performance WASM renderer for graphical subtitles (PGS and VobSub), written in Rust.

Started as a fork of Arcus92's [libpgs-js](https://github.com/Arcus92/libpgs-js), this project is re-engineered to maximize performance and extend functionality to VobSub, which was not supported by the original library. It remains fully backward compatible (only for PGS - obliviously). Special thanks to the original project for the inspiration!

## Features

- **PGS (Blu-ray)** subtitle parsing and rendering
- **VobSub (DVD)** subtitle parsing and rendering
- **High-performance** Rust-based rendering engine compiled to WebAssembly
- **Zero-copy** data transfer between JS and WASM where possible
- **Caching** for decoded bitmaps to optimize repeated rendering
- **TypeScript** support with full type definitions

## Showcase

### PGS (Created using Spp2Pgs)

https://gist.github.com/user-attachments/assets/55ac8e11-1964-4fb9-923e-dcac82dc7703

### Vobsub

https://gist.github.com/user-attachments/assets/a89ae9fe-23e4-4bc3-8cad-16a3f0fea665

## Installation

```bash
bun add libbitsub
```

### Setup for Web Workers (Recommended)

For best performance with large subtitle files, copy the WASM files to your public folder so Web Workers can access them:

```bash
# For Next.js, Vite, or similar frameworks
mkdir -p public/libbitsub
cp node_modules/libbitsub/pkg/libbitsub_bg.wasm public/libbitsub/
cp node_modules/libbitsub/pkg/libbitsub.js public/libbitsub/
```

This enables off-main-thread parsing which prevents UI freezing when loading large PGS files.

## Prerequisites

To build from source, you need:

- [Rust](https://rustup.rs/) (1.70+)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)

```bash
# Install wasm-pack
cargo install wasm-pack
```

## Building

```bash
# Build WASM module and TypeScript wrapper
bun run build

# Build WASM only (for development)
bun run build:wasm

# Build release version (optimized)
bun run build:wasm:release
```

## Usage

### Initialize WASM

Before using any renderer, you must initialize the WASM module:

```typescript
import { initWasm } from 'libbitsub'

// Initialize WASM (do this once at app startup)
await initWasm()
```

## High-Level API (Video Integration)

The high-level API automatically handles video synchronization, canvas overlay, and subtitle fetching.

### PGS Subtitles (Video-Integrated)

```typescript
import { PgsRenderer } from 'libbitsub'

// Create renderer with video element
const renderer = new PgsRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sup',
  workerUrl: '/libbitsub.js', // Optional, kept for API compatibility
  // Lifecycle callbacks (optional)
  onLoading: () => console.log('Loading subtitles...'),
  onLoaded: () => console.log('Subtitles loaded!'),
  onError: (error) => console.error('Failed to load:', error)
})

// The renderer automatically:
// - Fetches the subtitle file
// - Creates a canvas overlay on the video
// - Syncs rendering with video playback
// - Handles resize events

// When done:
renderer.dispose()
```

### VobSub Subtitles (Video-Integrated)

```typescript
import { VobSubRenderer } from 'libbitsub'

// Create renderer with video element
const renderer = new VobSubRenderer({
  video: videoElement,
  subUrl: '/subtitles/movie.sub',
  idxUrl: '/subtitles/movie.idx', // Optional, defaults to .sub path with .idx extension
  workerUrl: '/libbitsub.js', // Optional
  // Lifecycle callbacks (optional)
  onLoading: () => setIsLoading(true),
  onLoaded: () => setIsLoading(false),
  onError: (error) => {
    setIsLoading(false)
    console.error('Subtitle error:', error)
  }
})

// When done:
renderer.dispose()
```

### Subtitle Display Settings

Both `PgsRenderer` and `VobSubRenderer` support real-time customization of subtitle size and position:

```typescript
// Get current settings
const settings = renderer.getDisplaySettings()
console.log(settings)
// Output: { scale: 1.0, verticalOffset: 0 }

// Update settings
renderer.setDisplaySettings({
  scale: 1.2, // 1.2 = 120% size
  verticalOffset: -10 // -10% (move up 10% of video height)
})

// Reset to defaults
renderer.resetDisplaySettings()
```

**Settings Reference:**

- `scale` (number): Scale factor for subtitles.
  - `1.0` = 100% (Original size)
  - `0.5` = 50%
  - `2.0` = 200%
  - Range: `0.1` to `3.0`

- `verticalOffset` (number): Vertical position offset as a percentage of video height.
  - `0` = Original position
  - Negative values move up (e.g., `-10` moves up by 10% of height)
  - Positive values move down (e.g., `10` moves down by 10% of height)
  - Range: `-50` to `50`

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
- `dispose(): void` - Clean up all resources

#### `VobSubRenderer`

- `constructor(options: VideoVobSubOptions)` - Create video-integrated VobSub renderer
- `getDisplaySettings(): SubtitleDisplaySettings` - Get current display settings
- `setDisplaySettings(settings: Partial<SubtitleDisplaySettings>): void` - Update display settings
- `resetDisplaySettings(): void` - Reset display settings to defaults
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
  subUrl: string // URL to subtitle file
  workerUrl?: string // Worker URL (for API compatibility)
  onLoading?: () => void // Called when subtitle loading starts
  onLoaded?: () => void // Called when subtitle loading completes
  onError?: (error: Error) => void // Called when subtitle loading fails
}
```

#### `VideoVobSubOptions`

```typescript
interface VideoVobSubOptions extends VideoSubtitleOptions {
  idxUrl?: string // URL to .idx file (optional)
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
