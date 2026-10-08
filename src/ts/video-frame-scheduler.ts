import type { SubtitleSynchronizationMode } from './types'

export interface VideoFrameTick {
  mediaTime: number
  presentedFrames: number | null
}

interface VideoFrameSource {
  currentTime: number
  paused?: boolean
  seeking?: boolean
  ended?: boolean
  readyState?: number
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

interface AnimationFrameScheduler {
  request(callback: FrameRequestCallback): number
  cancel(handle: number): void
}

interface WatchdogTimer {
  now(): number
  request(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  cancel(handle: ReturnType<typeof setTimeout>): void
}

const defaultWatchdogTimer: WatchdogTimer = {
  now: () => performance.now(),
  request: (callback, delay) => setTimeout(callback, delay),
  cancel: (handle) => clearTimeout(handle)
}

const watchdogInterval = 250
const watchdogGrace = 1000

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
  private watchdogHandle: ReturnType<typeof setTimeout> | null = null
  private lastWatchdogTime = 0
  private lastProgressTime = 0
  private lastVideoTime = 0
  private progressingSince: number | null = null
  private generation = 0
  private useVideoFrames: boolean

  constructor(
    private readonly video: VideoFrameSource,
    frameAware: boolean,
    private readonly onFrame: (tick: VideoFrameTick) => void,
    private readonly animationFrames: AnimationFrameScheduler = defaultAnimationFrameScheduler,
    private readonly watchdogTimer: WatchdogTimer = defaultWatchdogTimer
  ) {
    this.useVideoFrames = supportsFrameAwareSync(video, frameAware)
  }

  get mode(): SubtitleSynchronizationMode {
    return this.useVideoFrames ? 'video-frame' : 'animation-frame'
  }

  start(): void {
    this.stop()
    // Fallback is deliberate and permanent for this scheduler's lifetime,
    // including restarts. Re-probing a stalled native-HLS callback source
    // would repeatedly freeze subtitles for the watchdog grace period.
    const generation = this.generation
    this.resetWatchdogEvidence()
    this.schedule(generation)
    if (this.useVideoFrames) this.scheduleWatchdog(generation)
  }

  stop(): void {
    this.generation++

    if (this.watchdogHandle !== null) {
      this.watchdogTimer.cancel(this.watchdogHandle)
      this.watchdogHandle = null
    }

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

  private resetWatchdogEvidence(): void {
    this.lastWatchdogTime = this.watchdogTimer.now()
    this.lastProgressTime = this.lastWatchdogTime
    this.lastVideoTime = this.video.currentTime
    this.progressingSince = null
  }

  private scheduleWatchdog(generation: number): void {
    this.watchdogHandle = this.watchdogTimer.request(() => {
      if (generation !== this.generation || !this.useVideoFrames) return
      this.watchdogHandle = null

      const now = this.watchdogTimer.now()
      const currentTime = this.video.currentTime
      const elapsed = now - this.lastWatchdogTime
      const playing =
        !this.video.paused &&
        !this.video.seeking &&
        !this.video.ended &&
        (this.video.readyState === undefined || this.video.readyState >= 3)
      if (
        !playing ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > watchdogInterval * 3 ||
        !Number.isFinite(currentTime) ||
        !Number.isFinite(this.lastVideoTime) ||
        currentTime < this.lastVideoTime
      ) {
        this.progressingSince = null
        this.lastProgressTime = now
      } else if (currentTime > this.lastVideoTime) {
        this.lastProgressTime = now
        this.progressingSince ??= this.lastWatchdogTime
        if (now - this.progressingSince >= watchdogGrace) {
          // Invalidate the pending video callback before cancellation: some
          // implementations can still deliver a cancelled callback.
          this.useVideoFrames = false
          this.stop()
          this.schedule(this.generation)
          return
        }
      } else if (now - this.lastProgressTime >= watchdogGrace) {
        // Brief equal samples can come from a quantized media clock. Only
        // sustained inactivity discards progress, and only advancement fails.
        this.progressingSince = null
      }
      this.lastWatchdogTime = now
      this.lastVideoTime = currentTime
      this.scheduleWatchdog(generation)
    }, watchdogInterval)
  }

  private schedule(generation: number): void {
    if (generation !== this.generation) return

    if (this.useVideoFrames) {
      const requestVideoFrameCallback = this.video.requestVideoFrameCallback
      if (typeof requestVideoFrameCallback === 'function') {
        try {
          this.videoFrameHandle = requestVideoFrameCallback.call(this.video, (_now, metadata) => {
            if (generation !== this.generation || !this.useVideoFrames) return
            this.videoFrameHandle = null
            this.resetWatchdogEvidence()

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

    if (this.watchdogHandle !== null) {
      this.watchdogTimer.cancel(this.watchdogHandle)
      this.watchdogHandle = null
    }
    this.animationFrameHandle = this.animationFrames.request(() => {
      if (generation !== this.generation) return
      this.animationFrameHandle = null
      try {
        this.onFrame({ mediaTime: this.video.currentTime, presentedFrames: null })
      } finally {
        this.schedule(generation)
      }
    })
  }
}
