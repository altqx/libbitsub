import type { SubtitleSynchronizationMode } from './types'

export interface VideoFrameTick {
  mediaTime: number
  presentedFrames: number | null
}

interface VideoFrameSource {
  currentTime: number
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

interface AnimationFrameScheduler {
  request(callback: FrameRequestCallback): number
  cancel(handle: number): void
}

const defaultAnimationFrameScheduler: AnimationFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle)
}

export function supportsFrameAwareSync(video: VideoFrameSource, enabled = true): boolean {
  return enabled && typeof video.requestVideoFrameCallback === 'function'
}

/**
 * Schedule one callback per presented video frame when possible, with an
 * animation-frame/currentTime compatibility fallback.
 */
export class VideoFrameScheduler {
  private animationFrameHandle: number | null = null
  private videoFrameHandle: number | null = null
  private generation = 0
  private useVideoFrames: boolean

  constructor(
    private readonly video: VideoFrameSource,
    frameAware: boolean,
    private readonly onFrame: (tick: VideoFrameTick) => void,
    private readonly animationFrames: AnimationFrameScheduler = defaultAnimationFrameScheduler
  ) {
    this.useVideoFrames = supportsFrameAwareSync(video, frameAware)
  }

  get mode(): SubtitleSynchronizationMode {
    return this.useVideoFrames ? 'video-frame' : 'animation-frame'
  }

  start(): void {
    this.stop()
    const generation = this.generation
    this.schedule(generation)
  }

  stop(): void {
    this.generation++

    if (this.videoFrameHandle !== null) {
      const cancelVideoFrameCallback = this.video.cancelVideoFrameCallback
      if (typeof cancelVideoFrameCallback === 'function') {
        try {
          cancelVideoFrameCallback.call(this.video, this.videoFrameHandle)
        } catch {
          // A detached or replaced video may reject an otherwise valid handle.
        }
      }
      this.videoFrameHandle = null
    }

    if (this.animationFrameHandle !== null) {
      this.animationFrames.cancel(this.animationFrameHandle)
      this.animationFrameHandle = null
    }
  }

  private schedule(generation: number): void {
    if (generation !== this.generation) return

    if (this.useVideoFrames) {
      const requestVideoFrameCallback = this.video.requestVideoFrameCallback
      if (typeof requestVideoFrameCallback === 'function') {
        try {
          this.videoFrameHandle = requestVideoFrameCallback.call(this.video, (_now, metadata) => {
            this.videoFrameHandle = null
            if (generation !== this.generation) return

            const mediaTime = Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : this.video.currentTime
            try {
              this.onFrame({
                mediaTime,
                presentedFrames: Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : null
              })
            } finally {
              this.schedule(generation)
            }
          })
          return
        } catch {
          this.useVideoFrames = false
        }
      } else {
        this.useVideoFrames = false
      }
    }

    this.animationFrameHandle = this.animationFrames.request(() => {
      this.animationFrameHandle = null
      if (generation !== this.generation) return
      try {
        this.onFrame({ mediaTime: this.video.currentTime, presentedFrames: null })
      } finally {
        this.schedule(generation)
      }
    })
  }
}
