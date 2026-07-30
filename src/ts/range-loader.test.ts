import { expect, test } from 'bun:test'
import { fetchSubtitleAsset, probeRangeSupport } from './range-loader'

function makeStreamResponse(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    }
  })
  return new Response(stream, init)
}

test('probeRangeSupport detects 206 partial content', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0]), {
      status: 206,
      headers: {
        'Content-Range': 'bytes 0-0/4096',
        'Accept-Ranges': 'bytes',
        'Content-Length': '1'
      }
    })) as typeof fetch

  try {
    const probe = await probeRangeSupport('https://example.test/movie.sup')
    expect(probe.supportsRange).toBe(true)
    expect(probe.size).toBe(4096)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchSubtitleAsset streams chunks and reports progress', async () => {
  const originalFetch = globalThis.fetch
  const chunkA = new Uint8Array([1, 2, 3, 4])
  const chunkB = new Uint8Array([5, 6])
  const received: number[] = []
  const progressLoaded: number[] = []

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.headers && new Headers(init.headers).has('Range')) {
      return new Response(null, { status: 200, headers: { 'Accept-Ranges': 'none', 'Content-Length': '6' } })
    }
    return makeStreamResponse([chunkA, chunkB], {
      status: 200,
      headers: { 'Content-Length': '6', 'Accept-Ranges': 'none' }
    })
  }) as typeof fetch

  try {
    const result = await fetchSubtitleAsset(
      'https://example.test/track.sup',
      {
        preferRange: true,
        onProgress: (progress) => progressLoaded.push(progress.loaded)
      },
      async (chunk) => {
        received.push(...chunk)
      }
    )

    expect(Array.from(result.data)).toEqual([1, 2, 3, 4, 5, 6])
    expect(received).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.strategy).toBe('stream')
    expect(progressLoaded.at(-1)).toBe(6)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchSubtitleAsset uses range-chunks for large range-capable assets', async () => {
  const originalFetch = globalThis.fetch
  const total = 8
  const body = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17])
  let rangeCalls = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const range = headers.get('Range')
    if (range === 'bytes=0-0') {
      return new Response(new Uint8Array([body[0]]), {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-0/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': '1'
        }
      })
    }

    const match = range ? /bytes=(\d+)-(\d+)/.exec(range) : null
    if (match) {
      rangeCalls += 1
      const start = Number(match[1])
      const end = Number(match[2])
      const slice = body.subarray(start, end + 1)
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(slice.byteLength),
          'Accept-Ranges': 'bytes'
        }
      })
    }

    throw new Error(`Unexpected fetch: range=${range}`)
  }) as typeof fetch

  try {
    const result = await fetchSubtitleAsset('https://example.test/large.mks', {
      preferRange: true,
      rangeChunkThreshold: 4,
      rangeChunkSize: 3
    })

    expect(Array.from(result.data)).toEqual(Array.from(body))
    expect(result.strategy).toBe('range-chunks')
    expect(result.rangeSupported).toBe(true)
    expect(rangeCalls).toBeGreaterThan(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
