import { describe, expect, test } from 'bun:test'
import { VideoFrameScheduler } from './video-frame-scheduler'

type VideoCallback = VideoFrameRequestCallback
type AnimationCallback = FrameRequestCallback

function createAnimationFrames() {
  let nextHandle = 1
  const callbacks = new Map<number, AnimationCallback>()
  const cancelled: number[] = []

  return {
    scheduler: {
      request(callback: AnimationCallback): number {
        const handle = nextHandle++
        callbacks.set(handle, callback)
        return handle
      },
      cancel(handle: number): void {
        cancelled.push(handle)
        callbacks.delete(handle)
      }
    },
    callbacks,
    cancelled
  }
}

describe('VideoFrameScheduler', () => {
  test('uses presented-frame mediaTime and reschedules after each callback', () => {
    let nextHandle = 10
    const callbacks = new Map<number, VideoCallback>()
    const cancelled: number[] = []
    const ticks: Array<{ mediaTime: number; presentedFrames: number | null }> = []
    const animationFrames = createAnimationFrames()
    const video = {
      currentTime: 4,
      requestVideoFrameCallback(callback: VideoCallback): number {
        const handle = nextHandle++
        callbacks.set(handle, callback)
        return handle
      },
      cancelVideoFrameCallback(handle: number): void {
        cancelled.push(handle)
        callbacks.delete(handle)
      }
    }

    const scheduler = new VideoFrameScheduler(video, true, (tick) => ticks.push(tick), animationFrames.scheduler)
    scheduler.start()

    expect(scheduler.mode).toBe('video-frame')
    expect(callbacks.has(10)).toBe(true)
    callbacks.get(10)!(100, { mediaTime: 4.125, presentedFrames: 8 } as VideoFrameCallbackMetadata)

    expect(ticks).toEqual([{ mediaTime: 4.125, presentedFrames: 8 }])
    expect(callbacks.has(11)).toBe(true)
    expect(animationFrames.callbacks.size).toBe(0)

    scheduler.stop()
    expect(cancelled).toEqual([11])
  })

  test('falls back to animation frames when frame-aware sync is unavailable or disabled', () => {
    const animationFrames = createAnimationFrames()
    const ticks: number[] = []
    const video = { currentTime: 2.5 }
    const scheduler = new VideoFrameScheduler(
      video,
      true,
      (tick) => ticks.push(tick.mediaTime),
      animationFrames.scheduler
    )

    scheduler.start()
    expect(scheduler.mode).toBe('animation-frame')
    animationFrames.callbacks.get(1)!(100)
    video.currentTime = 2.75
    animationFrames.callbacks.get(2)!(116)

    expect(ticks).toEqual([2.5, 2.75])

    scheduler.stop()
    expect(animationFrames.cancelled).toEqual([3])

    let videoFrameRequests = 0
    const disabledAnimationFrames = createAnimationFrames()
    const disabledScheduler = new VideoFrameScheduler(
      {
        currentTime: 3,
        requestVideoFrameCallback(): number {
          videoFrameRequests++
          return 10
        }
      },
      false,
      () => {},
      disabledAnimationFrames.scheduler
    )
    disabledScheduler.start()

    expect(disabledScheduler.mode).toBe('animation-frame')
    expect(videoFrameRequests).toBe(0)
    disabledScheduler.stop()
  })

  test('ignores a stale video-frame callback after stop', () => {
    let callback: VideoCallback | null = null
    const animationFrames = createAnimationFrames()
    const ticks: number[] = []
    const video = {
      currentTime: 1,
      requestVideoFrameCallback(next: VideoCallback): number {
        callback = next
        return 7
      },
      cancelVideoFrameCallback() {}
    }
    const scheduler = new VideoFrameScheduler(
      video,
      true,
      (tick) => ticks.push(tick.mediaTime),
      animationFrames.scheduler
    )

    scheduler.start()
    scheduler.stop()
    ;(callback as VideoCallback | null)?.(100, { mediaTime: 1.25, presentedFrames: 2 } as VideoFrameCallbackMetadata)

    expect(ticks).toEqual([])
  })

  test('uses currentTime when callback metadata has no finite mediaTime', () => {
    let callback: VideoCallback | null = null
    const animationFrames = createAnimationFrames()
    const ticks: number[] = []
    const video = {
      currentTime: 9.5,
      requestVideoFrameCallback(next: VideoCallback): number {
        callback = next
        return 1
      },
      cancelVideoFrameCallback() {}
    }
    const scheduler = new VideoFrameScheduler(
      video,
      true,
      (tick) => ticks.push(tick.mediaTime),
      animationFrames.scheduler
    )

    scheduler.start()
    ;(callback as VideoCallback | null)?.(100, {
      mediaTime: Number.NaN,
      presentedFrames: 1
    } as VideoFrameCallbackMetadata)

    expect(ticks).toEqual([9.5])
    scheduler.stop()
  })
})

function createWatchdogFixture(withPlaybackState = true) {
  let now = 0
  let nextHandle = 1
  const timers = new Map<number, () => void>()
  const frames = new Map<number, VideoCallback>()
  const cancelledFrames: number[] = []
  const animationFrames = createAnimationFrames()
  const ticks: number[] = []
  const video = {
    currentTime: 0,
    paused: withPlaybackState ? false : undefined,
    seeking: withPlaybackState ? false : undefined,
    ended: withPlaybackState ? false : undefined,
    readyState: withPlaybackState ? 4 : undefined,
    requestVideoFrameCallback(callback: VideoCallback) {
      const handle = nextHandle++
      frames.set(handle, callback)
      return handle
    },
    cancelVideoFrameCallback(handle: number) {
      cancelledFrames.push(handle)
      frames.delete(handle)
    }
  }
  const timer = {
    now: () => now,
    request(callback: () => void) {
      const handle = nextHandle++
      timers.set(handle, callback)
      return handle
    },
    cancel(handle: number) {
      timers.delete(handle)
    }
  }
  const scheduler = new VideoFrameScheduler(
    video,
    true,
    (tick) => ticks.push(tick.mediaTime),
    animationFrames.scheduler,
    timer
  )
  function sample(progress = 0.25, elapsed = 250) {
    now += elapsed
    video.currentTime += progress
    const [handle, callback] = timers.entries().next().value!
    timers.delete(handle)
    callback()
  }
  function frame() {
    const [handle, callback] = frames.entries().next().value!
    frames.delete(handle)
    callback(now, { mediaTime: video.currentTime, presentedFrames: 1 } as VideoFrameCallbackMetadata)
  }
  return {
    scheduler,
    video,
    timer,
    timers,
    frames,
    cancelledFrames,
    animationFrames,
    ticks,
    sample,
    frame,
    setNow: (value: number) => {
      now = value
    }
  }
}

describe('VideoFrameScheduler watchdog', () => {
  test('recovers missing callbacks and ignores their late delivery', () => {
    const f = createWatchdogFixture()
    f.scheduler.start()
    const stale = [...f.frames.values()][0]!
    for (let i = 0; i < 4; i++) f.sample()
    expect(f.scheduler.mode).toBe('animation-frame')
    expect(f.cancelledFrames.length).toBe(1)
    expect(f.timers.size).toBe(0)
    stale(1000, { mediaTime: 99 } as VideoFrameCallbackMetadata)
    expect(f.ticks).toEqual([])
    expect(f.animationFrames.callbacks.size).toBe(1)
    f.animationFrames.callbacks.get(1)!(1000)
    expect(f.ticks).toEqual([1])
    f.scheduler.stop()
    expect(f.animationFrames.cancelled).toEqual([2])
  })

  test('recovers with lightweight video sources that omit playback state', () => {
    const f = createWatchdogFixture(false)
    f.scheduler.start()
    for (let i = 0; i < 4; i++) f.sample()
    expect(f.scheduler.mode).toBe('animation-frame')
    f.scheduler.stop()
  })

  test('keeps scheduling when the frame consumer throws', () => {
    const f = createWatchdogFixture()
    const scheduler = new VideoFrameScheduler(
      f.video,
      true,
      () => {
        throw new Error('consumer failed')
      },
      f.animationFrames.scheduler,
      f.timer
    )
    scheduler.start()
    expect(() => f.frame()).toThrow('consumer failed')
    expect(f.frames.size).toBe(1)
    expect(f.timers.size).toBe(1)
    scheduler.stop()
    expect(f.frames.size).toBe(0)
    expect(f.timers.size).toBe(0)
  })

  test('healthy and sparse callbacks reset evidence, then dropout recovers', () => {
    const f = createWatchdogFixture()
    f.scheduler.start()
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 3; i++) f.sample()
      f.frame()
      expect(f.scheduler.mode).toBe('video-frame')
    }
    for (let i = 0; i < 4; i++) f.sample()
    expect(f.scheduler.mode).toBe('animation-frame')
    f.scheduler.stop()
  })

  test('identical currentTime and interrupted playback reset evidence', () => {
    for (const state of ['paused', 'seeking', 'ended', 'buffering', 'stationary', 'gap'] as const) {
      const f = createWatchdogFixture()
      f.scheduler.start()
      for (let i = 0; i < 3; i++) f.sample()
      if (state === 'buffering') f.video.readyState = 2
      else if (state === 'paused' || state === 'seeking' || state === 'ended') f.video[state] = true
      if (state === 'stationary') {
        for (let i = 0; i < 4; i++) f.sample(0)
      } else {
        f.sample(10, state === 'gap' ? 2000 : 250)
      }
      expect(f.scheduler.mode).toBe('video-frame')
      f.video.paused = f.video.seeking = f.video.ended = false
      f.video.readyState = 4
      for (let i = 0; i < 3; i++) f.sample()
      expect(f.scheduler.mode).toBe('video-frame')
      f.sample()
      expect(f.scheduler.mode).toBe('animation-frame')
      f.scheduler.stop()
    }
  })

  test('quantized currentTime preserves progress but equal samples never trigger fallback', () => {
    const f = createWatchdogFixture()
    f.scheduler.start()
    for (const progress of [0.1, 0, 0.1, 0, 0.1]) {
      f.sample(progress)
      if (progress === 0) expect(f.scheduler.mode).toBe('video-frame')
    }
    expect(f.scheduler.mode).toBe('animation-frame')
    f.scheduler.stop()
  })

  test('backwards and nonfinite media clocks reset evidence and can recover', () => {
    for (const currentTime of [-1, Number.NaN, Infinity]) {
      const f = createWatchdogFixture()
      f.scheduler.start()
      for (let i = 0; i < 3; i++) f.sample()
      f.video.currentTime = currentTime
      f.sample(0)
      expect(f.scheduler.mode).toBe('video-frame')
      f.video.currentTime = 1
      f.sample(0)
      for (let i = 0; i < 2; i++) f.sample()
      expect(f.scheduler.mode).toBe('video-frame')
      f.sample()
      if (f.scheduler.mode === 'video-frame') f.sample()
      expect(f.scheduler.mode).toBe('animation-frame')
      f.scheduler.stop()
    }
  })

  test('backwards and nonfinite watchdog clocks discard stale evidence', () => {
    for (const now of [-100, Number.NaN, Infinity]) {
      const f = createWatchdogFixture()
      f.scheduler.start()
      for (let i = 0; i < 3; i++) f.sample()
      f.setNow(now)
      f.sample(0.25, 0)
      expect(f.scheduler.mode).toBe('video-frame')
      f.setNow(2000)
      f.sample(0.25, 0)
      for (let i = 0; i < 3; i++) f.sample()
      expect(f.scheduler.mode).toBe('video-frame')
      f.sample()
      expect(f.scheduler.mode).toBe('animation-frame')
      f.scheduler.stop()
    }
  })

  test('absent or throwing cancellation cannot revive callbacks after fallback', () => {
    for (const throws of [false, true]) {
      const f = createWatchdogFixture()
      if (throws)
        f.video.cancelVideoFrameCallback = () => {
          throw new Error('detached')
        }
      else Reflect.deleteProperty(f.video, 'cancelVideoFrameCallback')
      f.scheduler.start()
      const stale = [...f.frames.values()][0]!
      for (let i = 0; i < 4; i++) f.sample()
      stale(0, { mediaTime: 99 } as VideoFrameCallbackMetadata)
      expect(f.ticks).toEqual([])
      expect(f.animationFrames.callbacks.size).toBe(1)
      f.scheduler.stop()
    }
  })

  test('production timer adapter polls at the requested interval and recovers', () => {
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
    let now = 0
    let nextHandle = 1
    const timers = new Map<number, () => void>()
    const delays: number[] = []
    const cancelled: number[] = []
    const f = createWatchdogFixture()
    const scheduler = new VideoFrameScheduler(f.video, true, () => {}, f.animationFrames.scheduler)
    try {
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
      globalThis.setTimeout = ((callback: () => void, delay: number) => {
        delays.push(delay)
        const handle = nextHandle++
        timers.set(handle, callback)
        return handle
      }) as typeof setTimeout
      globalThis.clearTimeout = ((handle: number) => {
        timers.delete(handle)
      }) as typeof clearTimeout
      scheduler.start()
      for (let i = 0; i < 4; i++) {
        const [handle, callback] = timers.entries().next().value!
        timers.delete(handle)
        now += delays[i]!
        f.video.currentTime += 0.25
        callback()
      }
      expect(delays).toEqual([250, 250, 250, 250])
      expect(scheduler.mode).toBe('animation-frame')
      expect(timers.size).toBe(0)
      scheduler.stop()
      // A fresh frame scheduler also cancels its production timer on stop.
      const fresh = new VideoFrameScheduler(f.video, true, () => {}, f.animationFrames.scheduler)
      globalThis.clearTimeout = ((handle: number) => {
        cancelled.push(handle)
        timers.delete(handle)
      }) as typeof clearTimeout
      fresh.start()
      fresh.stop()
      expect(cancelled).toEqual([5])
      expect(timers.size).toBe(0)
    } finally {
      scheduler.stop()
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      if (originalNow) Object.defineProperty(performance, 'now', originalNow)
      else Reflect.deleteProperty(performance, 'now')
    }
  })

  test('stop cancels watchdog and frames; stale callbacks cannot alter restarted work', () => {
    const f = createWatchdogFixture()
    f.scheduler.start()
    const staleTimer = [...f.timers.values()][0]!
    const staleFrame = [...f.frames.values()][0]!
    f.scheduler.stop()
    expect(f.timers.size).toBe(0)
    expect(f.frames.size).toBe(0)
    f.scheduler.start()
    staleTimer()
    staleFrame(0, { mediaTime: 99 } as VideoFrameCallbackMetadata)
    expect(f.ticks).toEqual([])
    expect(f.timers.size).toBe(1)
    expect(f.frames.size).toBe(1)
    f.scheduler.stop()
    expect(f.timers.size).toBe(0)
    expect(f.frames.size).toBe(0)
  })

  test('request exceptions immediately fall back, including after a healthy frame', () => {
    for (const afterFrame of [false, true]) {
      const f = createWatchdogFixture()
      const request = f.video.requestVideoFrameCallback
      let requests = 0
      f.video.requestVideoFrameCallback = (callback) => {
        if (!afterFrame || requests++ > 0) throw new Error('unavailable')
        return request(callback)
      }
      f.scheduler.start()
      if (afterFrame) f.frame()
      expect(f.scheduler.mode).toBe('animation-frame')
      expect(f.timers.size).toBe(0)
      expect(f.animationFrames.callbacks.size).toBe(1)
      f.scheduler.stop()
    }
  })

  test('stale animation callback cannot clear restarted animation work', () => {
    const f = createWatchdogFixture()
    f.video.requestVideoFrameCallback = () => {
      throw new Error('unavailable')
    }
    f.scheduler.start()
    const stale = f.animationFrames.callbacks.get(1)!
    f.scheduler.start()
    stale(0)
    expect(f.ticks).toEqual([])
    f.scheduler.stop()
    expect(f.animationFrames.cancelled).toEqual([1, 2])
  })
})
