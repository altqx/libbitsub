# Compatibility & visual regression

libbitsub ships a formal compatibility suite that turns recent decoder and
worker correctness fixes into durable guarantees.

## What the suite covers

| Area                    | Guarantees                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Malformed PGS           | Bad magic, truncated segments, ODS length mismatches never panic and never produce bogus bitmaps                 |
| Malformed VobSub / IDX  | Missing palette still yields timestamps; corrupt packets fail closed                                             |
| Malformed MKS           | Non-`S_VOBSUB` tracks and empty/invalid blocks are rejected                                                      |
| Palette edge cases      | Index 255, short palettes, out-of-range indices, fully transparent entries                                       |
| Zero-length RLE         | PGS count-0 color/transparent runs do not hang; VobSub EOL uses the code color                                   |
| Alternate display sizes | 720×480, 1280×720, 1920×1080, 3840×2160 screen metrics round-trip                                                |
| Slow worker startup     | Concurrent `warmup()` / `ready()` / `getOrCreateWorker()` share one init; failures do not publish a ready worker |
| Golden pixels           | Software compositor fingerprints + Canvas2D/WebGL2/WebGPU parity                                                 |

## How to run

```bash
# Rust core compatibility + unit tests
bun run test

# TypeScript fixtures, goldens, worker startup
bun run test:ts

# Full local gate (Rust + TS + visual harness when Chromium is available)
bun run test:all

# Browser backend pixel parity (Chromium/Chrome required)
bun run test:visual
```

### Suite layout

| Path                               | Role                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `crates/core/src/compatibility.rs` | Rust fixtures + golden decoder tests                    |
| `src/ts/compatibility/`            | TS fixtures, pixel helpers, backend harness, Bun tests  |
| `tests/visual/`                    | Headless Chromium runner for Canvas2D / WebGL2 / WebGPU |
| `docs/COMPATIBILITY.md`            | This matrix                                             |

Synthetic fixtures are generated in-process (no large binary blobs). Real
sample assets remain under `src/testfiles/` and `crates/core/src/testfiles/`.

## Pixel-level golden policy

1. **Software golden** — `renderFrameData(..., { crop: 'screen' })` is the
   reference compositor. Bun unit tests lock fingerprints and sample pixels.
2. **Canvas2D** — must match software exactly (`maxChannelDelta = 0`).
3. **WebGL2 / WebGPU** — must match software within `maxChannelDelta ≤ 2`
   after un-premultiply + readback (GPU filtering/rounding tolerance).
4. Backend readback helpers:
   - `WebGL2Renderer.readPixels()`
   - `WebGPURenderer.readPixels()`

Intentional decoder or blend changes must update goldens in the same PR and
note the reason in the changelog / commit message.

## Browser / device support matrix

Support levels:

- **Full** — parse + render + worker path validated or expected to work
- **Core** — parse + Canvas2D/WebGL2 render; WebGPU may be absent
- **Best-effort** — works on current firmware but OEM WebViews vary
- **Unsupported** — missing required Web APIs

| Environment                         | Engine notes                 | PGS                 | VobSub              | MKS                 | Worker      | Canvas2D             | WebGL2      | WebGPU      | Level         |
| ----------------------------------- | ---------------------------- | ------------------- | ------------------- | ------------------- | ----------- | -------------------- | ----------- | ----------- | ------------- |
| Chrome / Edge 120+ (desktop)        | Blink                        | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | ✓           | Full          |
| Chrome Android 120+                 | Blink                        | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | ✓\*         | Full          |
| Firefox 120+                        | Gecko                        | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | ✓\*         | Full          |
| Safari 17+ (macOS)                  | WebKit                       | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | ✓\*         | Full          |
| Safari iOS / iPadOS 17+             | WebKit                       | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | Limited     | Core          |
| Samsung Internet 24+                | Blink                        | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | ✓\*         | Full          |
| Chromium Embedded (Electron 28+)    | Blink                        | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | ✓\*         | Full          |
| **webOS TV 6 / 22 / 23**            | Chromium 53→108 family (OEM) | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | —           | Core          |
| **webOS TV 24+**                    | Newer Chromium WebApp        | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | Best-effort | Core / Full\* |
| Tizen TV 6.5+                       | Chromium-based               | ✓                   | ✓                   | ✓                   | ✓           | ✓                    | ✓           | —           | Core          |
| vidda / Hisense / other TV WebViews | Varies                       | ✓                   | ✓                   | ✓                   | Best-effort | ✓                    | Best-effort | —           | Best-effort   |
| Node / Bun (no DOM)                 | —                            | Parse via WASM only | Parse via WASM only | Parse via WASM only | Mockable    | Software golden only | —           | —           | Test-only     |

\* WebGPU availability depends on OS/GPU flags and may fall back automatically
to WebGL2, then Canvas2D.

### webOS-specific notes

- Prefer **worker prewarm** (`warmup()` / `ready()`) during app boot so the
  first subtitle track switch does not pay WASM import cost on the UI thread.
- Prefer **Range / streaming loads** for large `.sup` / `.mks` assets on TV
  storage or CDN paths with limited bandwidth.
- WebOS 6–23: treat **WebGL2 + Canvas2D** as the supported GPU ladder; do not
  require WebGPU.
- Some webOS WebViews restrict module workers or `file://` WASM URLs — serve
  `libbitsub` glue/WASM over `http(s)` and keep the package asset URLs
  resolvable (bundler emit or `/libbitsub/` public fallback).
- Validate on device with `debug: true` and `onEvent` (`renderer-change`,
  `worker-state`, `warning`) before shipping a TV build.

### Automatic backend ladder

```
WebGPU → WebGL2 → Worker OffscreenCanvas → Canvas2D
```

- **WebGPU / WebGL2** — main-thread GPU present; worker still preferred for parse/decode (transfer RGBA path).
- **Worker OffscreenCanvas** — when GPU is unavailable but `Worker` + `OffscreenCanvas` +
  `transferControlToOffscreen` + an OffscreenCanvas 2D context exist, decode **and** Canvas2D present run in the shared worker
  (no RGBA transfer back to the UI thread). Helps subtitle switching on constrained TVs.
- **Canvas2D** — main-thread present fallback for older WebViews without OffscreenCanvas transfer.

High-level renderers select the first available enabled backend and emit
`renderer-change` / fallback callbacks when stepping down. Setting `offscreenRender: false`
disables and skips Worker OffscreenCanvas even when the runtime supports it.

Use `getRuntimeCapabilities()` to explain why a device landed on the transfer or Canvas2D path:

```ts
import { getRuntimeCapabilities } from 'libbitsub'

const caps = getRuntimeCapabilities()
// caps.preferredPresentPath: 'main-webgpu' | 'main-webgl2' | 'worker-offscreen' | 'main-canvas2d' | 'main-thread'
// caps.reasons: human-readable missing-feature notes
```

## CI expectations

| Job command            | Required                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test` (cargo) | Yes                                                                                                                                                                                    |
| `bun run test:ts`      | Yes                                                                                                                                                                                    |
| `bun run test:visual`  | Required in CI (Chrome installed via `browser-actions/setup-chrome`). Locally requires Chrome/Chromium or `CHROME_PATH`. Set `VISUAL_OPTIONAL=1` to skip when no browser is available. |

## Extending the suite

1. Add a synthetic fixture builder in `crates/core/src/compatibility.rs`
   and/or `src/ts/compatibility/fixtures.ts`.
2. Lock decoder output with pixel assertions or `fingerprintRgba`.
3. If the change affects GPU upload/blend, extend `tests/visual/index.html`
   and keep the ≤2 channel delta policy unless documenting a new tolerance.
4. Update this matrix when adding a newly validated device class.
