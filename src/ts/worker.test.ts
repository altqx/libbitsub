import { expect, test } from 'bun:test'

import { getOrCreateWorker, isWorkerReady, ready, resetWorkerForTests, sendToWorker, warmup } from './worker'

class MockWorker {
  static response: { type: 'initComplete'; success: true } | { type: 'error'; message: string }
  static requestResponse: { type: 'error'; message: string } | null = null
  static failWithNativeError = false
  static instances: MockWorker[] = []
  static initMessages: { type: string; wasmUrl?: string; glueUrl?: string }[] = []
  terminated = false

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor(..._args: unknown[]) {
    MockWorker.instances.push(this)
  }

  postMessage(message: { _id: number; type: string; wasmUrl?: string; glueUrl?: string }): void {
    if (message.type === 'init') {
      MockWorker.initMessages.push({
        type: message.type,
        wasmUrl: message.wasmUrl,
        glueUrl: message.glueUrl
      })
    }
    setTimeout(() => {
      if (MockWorker.failWithNativeError) {
        this.onerror?.(new ErrorEvent('error', { message: 'Worker crashed' }))
        return
      }
      const response = message.type === 'init' ? MockWorker.response : MockWorker.requestResponse
      if (response) this.onmessage?.({ data: { _id: message._id, ...response } } as MessageEvent)
    }, 10)
  }

  terminate(): void {
    this.terminated = true
  }
}

const originalWorker = globalThis.Worker
globalThis.Worker = MockWorker as unknown as typeof Worker

const hadWindow = typeof globalThis.window !== 'undefined'
if (!hadWindow) {
  ;(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis
}

resetWorkerForTests()
MockWorker.instances = []
MockWorker.initMessages = []

test('rejects an initialization error from the worker', async () => {
  MockWorker.response = { type: 'error', message: 'WASM glue failed to load' }

  await expect(getOrCreateWorker()).rejects.toThrow('WASM glue failed to load')
})

test('recovers from a native initialization error', async () => {
  MockWorker.failWithNativeError = true
  MockWorker.response = { type: 'initComplete', success: true }

  await expect(getOrCreateWorker()).rejects.toThrow('Worker crashed')
  expect(MockWorker.instances.at(-1)?.terminated).toBe(true)

  MockWorker.failWithNativeError = false
})

test('waits for an in-flight worker WASM initialization', async () => {
  MockWorker.response = { type: 'initComplete', success: true }

  const first = getOrCreateWorker()
  const second = getOrCreateWorker()

  expect(second).toBe(first)
  expect(await second).toBe(await first)
  expect(isWorkerReady()).toBe(true)
})

test('warmup and ready share a single worker-init promise', async () => {
  MockWorker.response = { type: 'initComplete', success: true }

  MockWorker.instances.at(-1)?.onerror?.(new ErrorEvent('error', { message: 'reset' }))
  expect(isWorkerReady()).toBe(false)

  const warm = warmup()
  const wait = ready()
  const viaGet = getOrCreateWorker()

  await Promise.all([warm, wait, viaGet])
  expect(isWorkerReady()).toBe(true)
  await expect(ready()).resolves.toBeUndefined()
  expect(MockWorker.initMessages.filter((message) => message.type === 'init').length).toBeGreaterThanOrEqual(1)
})

test('does not publish the shared worker when WASM init fails', async () => {
  MockWorker.response = { type: 'error', message: 'import failed' }

  MockWorker.instances.at(-1)?.onerror?.(new ErrorEvent('error', { message: 'reset' }))
  expect(isWorkerReady()).toBe(false)

  await expect(warmup()).rejects.toThrow('import failed')
  expect(isWorkerReady()).toBe(false)
  expect(MockWorker.instances.at(-1)?.terminated).toBe(true)

  MockWorker.response = { type: 'initComplete', success: true }
  await warmup()
  expect(isWorkerReady()).toBe(true)
})

test('returns ordinary worker errors to renderer callers', async () => {
  MockWorker.requestResponse = { type: 'error', message: 'Failed to render frame' }

  await expect(sendToWorker({ type: 'clearPgsCache', sessionId: 'test-session' })).resolves.toEqual({
    type: 'error',
    message: 'Failed to render frame'
  })

  MockWorker.requestResponse = null
})

test('sends the wasm and glue URLs to the worker during initialization', async () => {
  MockWorker.response = { type: 'initComplete', success: true }

  // Force a fresh worker so a new init message is sent.
  MockWorker.instances.at(-1)?.onerror?.(new ErrorEvent('error', { message: 'reset' }))
  await getOrCreateWorker()

  const initMessage = MockWorker.initMessages.at(-1)
  expect(initMessage?.type).toBe('init')
  expect(initMessage?.wasmUrl).toContain('libbitsub_bg.wasm')
  expect(typeof initMessage?.glueUrl).toBe('string')
  expect(initMessage?.glueUrl).toContain('libbitsub')
  expect(initMessage?.glueUrl?.endsWith('.js')).toBe(true)
})

test('rejects pending work and recovers after a native worker error', async () => {
  const worker = MockWorker.instances.at(-1)!
  const pendingRequest = sendToWorker({ type: 'clearPgsCache', sessionId: 'test-session' })

  worker.onerror?.(new ErrorEvent('error', { message: 'Worker crashed' }))

  await expect(pendingRequest).rejects.toThrow('Worker crashed')
  expect(worker.terminated).toBe(true)

  await expect(getOrCreateWorker()).resolves.toBeInstanceOf(MockWorker)
  resetWorkerForTests()
  globalThis.Worker = originalWorker
  if (!hadWindow) {
    Reflect.deleteProperty(globalThis, 'window')
  }
})
