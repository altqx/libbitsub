# TypeScript compatibility suite

| File | Purpose |
| --- | --- |
| `fixtures.ts` | Synthetic PGS / IDX / MKS builders (malformed, palette, sizes, RLE) |
| `pixels.ts` | Fingerprints + tolerant pixel diffs |
| `backends.ts` | Software / Canvas2D / WebGL2 / WebGPU render + readback |
| `imagedata-polyfill.ts` | `ImageData` for Bun unit tests |
| `*.test.ts` | Bun tests for fixtures, goldens, slow worker startup |

Browser GPU parity lives in `tests/visual/`. Matrix: `docs/COMPATIBILITY.md`.
