# libbitsub

High-performance WASM renderer for graphical subtitles (PGS and VobSub), written in Rust.

## Features

- **PGS (Blu-ray)** subtitle parsing and rendering
- **VobSub (DVD)** subtitle parsing and rendering
- **High-performance** Rust-based rendering engine compiled to WebAssembly
- **Zero-copy** data transfer between JS and WASM where possible
- **Caching** for decoded bitmaps to optimize repeated rendering
- **TypeScript** support with full type definitions

## Installation

```bash
npm install libbitsub
```

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
npm run build

# Build WASM only (for development)
npm run build:wasm

# Build release version (optimized)
npm run build:wasm:release
```

## Usage

### Initialize WASM

Before using the renderer, you must initialize the WASM module:

```typescript
import { initWasm, UnifiedSubtitleRenderer } from 'libbitsub';

// Initialize WASM (do this once at app startup)
await initWasm();
```

### PGS Subtitles

```typescript
import { initWasm, PgsRenderer } from 'libbitsub';

await initWasm();

const renderer = new PgsRenderer();

// Load PGS data from a .sup file
const response = await fetch('subtitles.sup');
const data = new Uint8Array(await response.arrayBuffer());
renderer.load(data);

// Get timestamps
const timestamps = renderer.getTimestamps(); // Float64Array in milliseconds

// Render at a specific time
const subtitleData = renderer.renderAtTimestamp(currentTimeInSeconds);
if (subtitleData) {
    for (const comp of subtitleData.compositionData) {
        ctx.putImageData(comp.pixelData, comp.x, comp.y);
    }
}

// Clean up
renderer.dispose();
```

### VobSub Subtitles

```typescript
import { initWasm, VobSubRenderer } from 'libbitsub';

await initWasm();

const renderer = new VobSubRenderer();

// Load from IDX + SUB files
const idxResponse = await fetch('subtitles.idx');
const idxContent = await idxResponse.text();
const subResponse = await fetch('subtitles.sub');
const subData = new Uint8Array(await subResponse.arrayBuffer());

renderer.loadFromData(idxContent, subData);

// Or load from SUB file only
// renderer.loadFromSubOnly(subData);

// Render
const subtitleData = renderer.renderAtTimestamp(currentTimeInSeconds);
if (subtitleData) {
    for (const comp of subtitleData.compositionData) {
        ctx.putImageData(comp.pixelData, comp.x, comp.y);
    }
}

renderer.dispose();
```

### Unified Renderer

For handling both formats with a single API:

```typescript
import { initWasm, UnifiedSubtitleRenderer } from 'libbitsub';

await initWasm();

const renderer = new UnifiedSubtitleRenderer();

// Load PGS
renderer.loadPgs(pgsData);

// Or load VobSub
// renderer.loadVobSub(idxContent, subData);

console.log(renderer.format); // 'pgs' or 'vobsub'

const subtitleData = renderer.renderAtTimestamp(time);
// ... render to canvas

renderer.dispose();
```

## API Reference

### `PgsRenderer`

- `load(data: Uint8Array): number` - Load PGS data, returns display set count
- `getTimestamps(): Float64Array` - Get all timestamps in milliseconds
- `count: number` - Number of display sets
- `findIndexAtTimestamp(timeSeconds: number): number` - Find index for timestamp
- `renderAtIndex(index: number): SubtitleData | undefined` - Render at index
- `renderAtTimestamp(timeSeconds: number): SubtitleData | undefined` - Render at time
- `clearCache(): void` - Clear decoded bitmap cache
- `dispose(): void` - Release resources

### `VobSubRenderer`

- `loadFromData(idxContent: string, subData: Uint8Array): void` - Load IDX + SUB
- `loadFromSubOnly(subData: Uint8Array): void` - Load SUB only
- Same rendering methods as PgsRenderer

### `UnifiedSubtitleRenderer`

- `loadPgs(data: Uint8Array): number` - Load PGS data
- `loadVobSub(idxContent: string, subData: Uint8Array): void` - Load VobSub
- `loadVobSubOnly(subData: Uint8Array): void` - Load SUB only
- `format: 'pgs' | 'vobsub' | null` - Current format
- Same rendering methods as above

### `SubtitleData`

```typescript
interface SubtitleData {
    width: number;      // Screen width
    height: number;     // Screen height
    compositionData: SubtitleCompositionData[];
}

interface SubtitleCompositionData {
    pixelData: ImageData;  // RGBA pixel data
    x: number;             // X position
    y: number;             // Y position
}
```

## Performance

The Rust/WASM implementation provides significant performance improvements over pure JavaScript:

- **RLE Decoding**: 2-5x faster bitmap decoding
- **Palette Application**: SIMD-optimized color conversion
- **Memory**: Reduced GC pressure with Rust's ownership model
- **Caching**: Efficient LRU caches for decoded bitmaps

## License

MIT
