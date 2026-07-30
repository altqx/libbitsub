import { expect, test } from 'bun:test'

import { getOrCreateWorker, isWorkerReady, ready, resetWorkerForTests, sendToWorker, warmup } from '../worker'

class SlowMockWorker {
  static initDelayMs = 150
  static response: { type: 'initComplete'; success: true } | { type: 'error'; message: string } = {
    type: 'initComplete',
    success: true
  }
  static instances: SlowMockWorker[] = []
  static initStartedAt: number[] = []
  terminated = false

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor(..._args: unknown[]) {
    SlowMockWorker.instances.push(this)
  }

  postMessage(message: { _id: number; type: string }): void {
    if (message.type === 'init') {
      SlowMockWorker.initStartedAt.push(Date.now())
      setTimeout(() => {
        this.onmessage?.({
          data: { _id: message._id, ...SlowMockWorker.response }
        } as MessageEvent)
      }, SlowMockWorker.initDelayMs)
      return
    }

    setTimeout(() => {
      this.onmessage?.({
        data: { _id: message._id, type: 'cacheCleared', sessionId: 'x' }
      } as MessageEvent)
    }, 5)
  }

  terminate(): void {
    this.terminated = true
  }
}

const originalWorker = globalThis.Worker
globalThis.Worker = SlowMockWorker as unknown as typeof Worker

const hadWindow = typeof globalThis.window !== 'undefined'
if (!hadWindow) {
  ;(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis
}

function beginSlowCase(): void {
  resetWorkerForTests()
  SlowMockWorker.instances = []
  SlowMockWorker.initStartedAt = []
  SlowMockWorker.response = { type: 'initComplete', success: true }
}

test('slow worker startup: concurrent warmup/ready share one init', async () => {
  beginSlowCase()
  SlowMockWorker.initDelayMs = 120

  const started = Date.now()
  const [warm, wait, viaGet] = await Promise.all([warmup(), ready(), getOrCreateWorker()])
  const elapsed = Date.now() - started

  expect(warm).toBeUndefined()
  expect(wait).toBeUndefined()
  expect(viaGet).toBeInstanceOf(SlowMockWorker)
  expect(isWorkerReady()).toBe(true)
  expect(elapsed).toBeGreaterThanOrEqual(100)
  // Only one init message should have been issued for the slow start.
  expect(SlowMockWorker.initStartedAt.length).toBe(1)
})

test('slow worker startup: getOrCreateWorker waits for slow init before requests', async () => {
  beginSlowCase()
  SlowMockWorker.initDelayMs = 80
  expect(isWorkerReady()).toBe(false)

  const started = Date.now()
  await getOrCreateWorker()
  const initElapsed = Date.now() - started
  expect(initElapsed).toBeGreaterThanOrEqual(60)
  expect(isWorkerReady()).toBe(true)

  const response = await sendToWorker({ type: 'clearPgsCache', sessionId: 'slow-start' })
  expect(response.type).toBe('cacheCleared')
})

test('slow worker startup: init failure does not publish ready worker', async () => {
  beginSlowCase()
  SlowMockWorker.response = { type: 'error', message: 'slow glue import failed' }
  SlowMockWorker.initDelayMs = 50

  await expect(warmup()).rejects.toThrow('slow glue import failed')
  expect(isWorkerReady()).toBe(false)
  expect(SlowMockWorker.instances.at(-1)?.terminated).toBe(true)

  // Restore healthy worker for any later tests in the same process.
  beginSlowCase()
  SlowMockWorker.initDelayMs = 10
  await warmup()
  expect(isWorkerReady()).toBe(true)

  resetWorkerForTests()
  globalThis.Worker = originalWorker
  if (!hadWindow) {
    Reflect.deleteProperty(globalThis, 'window')
  }
})
