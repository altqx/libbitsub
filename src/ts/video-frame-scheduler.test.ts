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
