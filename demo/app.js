import {
  DvbRenderer,
  createAutoSubtitleRenderer,
  detectSubtitleFormat,
  fetchSubtitleAsset,
  fetchSubtitleText,
  getRuntimeCapabilities,
  initWasm,
  openSubtitles,
  renderFrameData,
  toBlob
} from '/libbitsub/index.js'
import { buildDvbLiveChunk, buildDvbSample, buildPgsSample } from './fixtures.js'

const FLOWER_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
const LIVE_MPD_URL = 'https://live-linear.dvb.org/livesim2/tsbd_30/spd_4/utc_httpisoms/start_1735689600/01_avc_hd_sdr_heaac/manifest_livesim.mpd'

const $ = (id) => document.getElementById(id)
const video = $('player')
const stage = $('stage')
const ttmlRenderingDiv = $('ttml-rendering')

const state = {
  renderer: null,
  opened: null,
  detectedFormat: null,
  sourceKey: 'pgs',
  mediaKey: 'flower',
  dashPlayer: null,
  warnings: [],
  events: [],
  lastEvent: null,
  sourceInfo: null,
  scrubberActive: false
}

const TRACK_NOTES = {
  pgs: 'Synthetic PGS display sets with multiple timed bitmap cues.',
  vobsub: 'Public-domain .idx + .sub captions from the library test set, loaded through the URL path.',
  mks: 'Public-domain Matroska fixture from the library test set with an embedded S_VOBSUB track.',
  dvb: 'Synthetic DVB-SUB display sets with page, region, CLUT and object data.',
  'dvb-live': 'Empty DvbRenderer session; a DVB-SUB frame is appended after construction.'
}

function setText(id, value) {
  $(id).textContent = value
}

function setStatus(message, tone = '') {
  const target = $('load-status')
  target.textContent = message
  target.className = `inline-status${tone ? ` is-${tone}` : ''}`
}

function setPageStatus(message, tone = '') {
  setText('page-status', message)
  const dot = $('page-status-dot')
  dot.className = `status-dot${tone ? ` is-${tone}` : ''}`
}

function formatBytes(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function formatSeconds(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`
}

function formatTransportTime(value) {
  if (value == null || !Number.isFinite(value)) return '00:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function prettyJson(value) {
  return JSON.stringify(value, (_, entry) => {
    if (entry instanceof Float64Array || entry instanceof Uint8Array) return Array.from(entry)
    if (typeof entry === 'number' && !Number.isFinite(entry)) return null
    return entry
  }, 2)
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function readDisplaySettings() {
  return {
    scale: Number($('scale-range').value),
    opacity: Number($('opacity-range').value),
    bottomPadding: Number($('bottom-range').value),
    horizontalOffset: Number($('horizontal-range').value),
    verticalOffset: Number($('vertical-range').value),
    aspectMode: $('aspect-select').value,
    horizontalAlign: $('align-select').value,
    safeArea: 0
  }
}

function updateRangeOutputs() {
  setText('scale-value', `${Number($('scale-range').value).toFixed(2)}×`)
  setText('opacity-value', `${Math.round(Number($('opacity-range').value) * 100)}%`)
  setText('bottom-value', `${$('bottom-range').value}%`)
  setText('horizontal-value', `${$('horizontal-range').value}%`)
  setText('vertical-value', `${$('vertical-range').value}%`)
}

function applyDisplaySettings() {
  updateRangeOutputs()
  state.renderer?.setDisplaySettings(readDisplaySettings())
}

function pushEvent(type, payload = {}) {
  const item = {
    type,
    at: new Date().toLocaleTimeString([], { hour12: false }),
    payload
  }
  state.lastEvent = item
  state.events.push(item)
  state.events = state.events.slice(-40)
  renderEvents()
}

function eventPayload(event) {
  if (!event || typeof event !== 'object') return {}
  const result = {}
  for (const key of ['format', 'renderer', 'partial', 'strategy', 'loadedBytes', 'totalBytes', 'ratio', 'cue', 'stats', 'error']) {
    if (event[key] !== undefined) {
      const value = event[key]
      if (key === 'stats' && value) {
        result.stats = {
          framesRendered: value.framesRendered,
          currentIndex: value.currentIndex,
          syncMode: value.syncMode,
          renderFps: value.renderFps
        }
      } else if (key === 'error' && value) {
        result.error = value.message ?? String(value)
      } else {
        result[key] = value
      }
    }
  }
  return result
}

function handleRendererEvent(event) {
  if (!event) return
  const type = event.type ?? 'event'
  const payload = eventPayload(event)
  pushEvent(type, payload)

  if (type === 'renderer-change') setText('active-backend', event.renderer ?? '—')
  if (type === 'indexed') {
    setText('detected-format', event.format ?? state.detectedFormat ?? '—')
    updateMetadata(event.metadata)
  }
  if (type === 'load-progress') {
    const loaded = formatBytes(event.loadedBytes)
    const total = event.totalBytes ? ` / ${formatBytes(event.totalBytes)}` : ''
    setText('source-transfer', `${event.strategy ?? 'stream'} · ${loaded}${total}`)
  }
  if (type === 'error') {
    const message = event.error?.message ?? 'renderer error'
    setStatus(message, 'error')
    setPageStatus('error', 'error')
  }
  if (type === 'worker-state' && event.fallback) {
    appendDiagnostic('worker fallback', event.reason ?? 'worker path unavailable')
  }
}

function handleWarning(warning) {
  state.warnings.push(warning)
  state.warnings = state.warnings.slice(-20)
  const message = warning?.message ?? String(warning)
  appendDiagnostic(warning?.code ?? 'warning', message)
  setText('warning-count', `${state.warnings.length} warning${state.warnings.length === 1 ? '' : 's'}`)
  pushEvent('warning', { code: warning?.code, message })
}

function handleError(error) {
  const message = error?.message ?? String(error)
  appendDiagnostic(error?.code ?? 'error', message)
  pushEvent('error', { code: error?.code, message })
  setStatus(message, 'error')
  setPageStatus('error', 'error')
}

function appendDiagnostic(kind, message) {
  const current = $('diagnostics-output').textContent
  const prefix = current === 'No diagnostics.' ? '' : `${current}\n`
  $('diagnostics-output').textContent = `${prefix}[${kind}] ${message}`.slice(-6000)
}

function renderEvents() {
  const list = $('event-list')
  if (state.events.length === 0) {
    list.innerHTML = '<li class="empty-event">Events from the active renderer appear here.</li>'
    return
  }
  list.innerHTML = state.events
    .map((event) => {
      const kind = event.type === 'error' || event.type === 'warning' ? ` ${event.type}` : ''
      const payload = Object.keys(event.payload).length ? ` ${JSON.stringify(event.payload)}` : ''
      return `<li><span class="event-time">${event.at}</span> <span class="event-kind${kind}">${event.type}</span>${payload}</li>`
    })
    .join('')
}

function renderCapabilities() {
  const capabilities = getRuntimeCapabilities()
  const entries = [
    ['preferred present path', capabilities.preferredPresentPath],
    ['Canvas2D', capabilities.canvas2d],
    ['WebGL2', capabilities.webgl2],
    ['WebGPU', capabilities.webgpu],
    ['Worker', capabilities.worker],
    ['OffscreenCanvas', capabilities.offscreenCanvas],
    ['Worker OffscreenCanvas', capabilities.workerOffscreenRender],
    ['ImageBitmap export', capabilities.createImageBitmap]
  ]
  $('capability-list').innerHTML = entries
    .map(([name, value]) => {
      const isBoolean = typeof value === 'boolean'
      const yes = value === true
      return `<div class="capability-item"><span class="capability-dot ${isBoolean ? (yes ? 'yes' : 'no') : 'yes'}"></span><span class="capability-name">${name}</span><span class="capability-value">${isBoolean ? (yes ? 'yes' : 'no') : value}</span></div>`
    })
    .join('')
  appendDiagnostic('runtime', capabilities.reasons?.join(' ') || 'No runtime fallback reason.')
}

function updateMetadata(metadata = state.opened?.metadata ?? state.renderer?.getMetadata?.()) {
  if (!metadata) {
    setText('metadata-output', 'Load a source to inspect parser metadata.')
    setText('metadata-format', '—')
    return
  }
  setText('metadata-format', metadata.format ?? state.detectedFormat ?? '—')
  $('metadata-output').textContent = prettyJson({
    ...metadata,
    timestamps: state.opened ? Array.from(state.opened.timestamps).slice(0, 12) : undefined
  })
}

function updateInspector() {
  const renderer = state.renderer
  const metadata = renderer?.getMetadata?.() ?? state.opened?.metadata ?? null
  const stats = renderer?.getStats?.() ?? null
  const cache = renderer?.getCacheStats?.() ?? null
  const lastRender = renderer?.getLastRenderInfo?.() ?? null
  const cue = renderer?.getCurrentCueMetadata?.() ?? null

  if (metadata) updateMetadata(metadata)
  if (stats) {
    setText('stats-entry-count', `${stats.totalEntries ?? 0} entr${stats.totalEntries === 1 ? 'y' : 'ies'}`)
    $('stats-output').textContent = prettyJson({
      ...stats,
      cache,
      lastRender
    })
    setText('sync-mode', stats.syncMode ?? renderer?.getSynchronizationMode?.() ?? '—')
    setText('active-backend', lastRender?.backend ?? $('active-backend').textContent ?? '—')
    const cueText = cue ? `cue #${cue.index} · ${formatSeconds(cue.startTime)}–${formatSeconds(cue.endTime)}` : 'no active cue'
    setText('cue-badge', cueText)
    setText('session-summary', `${metadata?.format ?? state.detectedFormat ?? 'unknown'} · ${stats.totalEntries ?? 0} entries · ${metadata?.screenWidth ?? '—'}×${metadata?.screenHeight ?? '—'}`)
  }

  setText('time-badge', formatSeconds(video.currentTime))
  setText('transport-time', `${formatTransportTime(video.currentTime)} / ${formatTransportTime(video.duration)}`)
  if (!state.scrubberActive) {
    $('scrubber').max = Number.isFinite(video.duration) && video.duration > 0 ? String(video.duration) : '1'
    $('scrubber').value = Number.isFinite(video.duration) && video.duration > 0 ? String(video.currentTime) : '0'
  }
  $('play-toggle').textContent = video.paused ? 'Play' : 'Pause'
}

function rendererOptions() {
  const selectedBackend = $('backend-select').value
  return {
    video,
    container: stage,
    backend: selectedBackend,
    offscreenRender: $('offscreen-select').checked,
    frameAwareSync: $('frame-sync-select').checked,
    cacheLimit: Math.max(0, Number($('cache-select').value) || 0),
    prefetchWindow: { before: 1, after: Math.max(0, Number($('prefetch-select').value) || 0) },
    displaySettings: readDisplaySettings(),
    streamingLoad: true,
    rangeRequests: true,
    debug: true,
    onEvent: handleRendererEvent,
    onWarning: handleWarning,
    onError: handleError
  }
}

async function fetchSourceData(key) {
  if (key === 'pgs') {
    const data = buildPgsSample()
    return {
      data,
      fileName: 'libbitsub-demo.sup',
      rendererSource: { subContent: toArrayBuffer(data), fileName: 'libbitsub-demo.sup' },
      transfer: `memory · ${formatBytes(data.byteLength)}`
    }
  }

  if (key === 'dvb' || key === 'dvb-live') {
    const data = key === 'dvb-live' ? buildDvbLiveChunk() : buildDvbSample()
    return {
      data,
      fileName: 'libbitsub-demo.dv',
      rendererSource: key === 'dvb-live' ? {} : { subContent: toArrayBuffer(data), fileName: 'libbitsub-demo.dv' },
      transfer: `${key === 'dvb-live' ? 'push session' : 'memory'} · ${formatBytes(data.byteLength)}`
    }
  }

  const assetName = key === 'mks' ? 'vobsub.mks' : 'vobsub.sub'
  const assetUrl = `/assets/${assetName}`
  const asset = await fetchSubtitleAsset(assetUrl, {
    preferRange: true,
    onProgress: (progress) => {
      const total = progress.total ? ` / ${formatBytes(progress.total)}` : ''
      setText('source-transfer', `${progress.strategy} · ${formatBytes(progress.loaded)}${total}`)
    }
  })
  let idxContent
  if (key === 'vobsub') idxContent = await fetchSubtitleText('/assets/vobsub.idx')
  return {
    data: asset.data,
    idxContent,
    fileName: assetName,
    rendererSource:
      key === 'mks'
        ? { subUrl: assetUrl, fileName: assetName }
        : { subUrl: assetUrl, idxUrl: '/assets/vobsub.idx', fileName: assetName },
    transfer: `${asset.strategy} · ${formatBytes(asset.data.byteLength)}${asset.rangeSupported ? ' · range' : ''}`
  }
}

async function loadTrack() {
  const key = $('track-select').value
  state.sourceKey = key
  setText('track-note', TRACK_NOTES[key])
  setStatus('Loading source…')
  setPageStatus('loading')
  destroySubtitleSession()
  state.warnings = []
  setText('warning-count', '0 warnings')
  $('diagnostics-output').textContent = 'No diagnostics.'
  $('stage-note').classList.remove('is-hidden')
  setText('detected-format', '—')
  setText('active-backend', '—')
  setText('sync-mode', '—')
  setText('source-transfer', '—')

  try {
    await initWasm()
    const source = await fetchSourceData(key)
    state.sourceInfo = source
    setText('source-transfer', source.transfer)

    const lowLevelSource = {
      data: source.data,
      idxContent: source.idxContent,
      fileName: source.fileName
    }
    state.detectedFormat = detectSubtitleFormat(lowLevelSource)
    setText('detected-format', state.detectedFormat ?? 'unknown')

    try {
      state.opened = await openSubtitles(lowLevelSource, { debug: true, onWarning: handleWarning })
      updateMetadata(state.opened.metadata)
    } catch (error) {
      state.opened = null
      appendDiagnostic('low-level open', error?.message ?? String(error))
      pushEvent('low-level-error', { message: error?.message ?? String(error) })
    }

    const options = { ...rendererOptions(), ...source.rendererSource }
    if (key === 'dvb-live') {
      state.renderer = new DvbRenderer(options)
      await state.renderer.append(toArrayBuffer(source.data))
      await state.renderer.flush()
    } else {
      state.renderer = createAutoSubtitleRenderer(options)
      if (typeof state.renderer.flush === 'function') await state.renderer.flush()
    }

    $('stage-note').classList.add('is-hidden')
    setStatus(`${state.detectedFormat ?? key} renderer loaded`, 'ready')
    setPageStatus('ready', 'ready')
    pushEvent('session-ready', { format: state.detectedFormat, source: key })
    updateInspector()
  } catch (error) {
    handleError(error)
    setText('session-summary', 'The source could not be loaded.')
  }
}

function destroySubtitleSession() {
  state.renderer?.dispose?.()
  state.renderer = null
  state.opened?.dispose?.()
  state.opened = null
  setText('metadata-output', 'Load a source to inspect parser metadata.')
  setText('stats-output', 'No renderer statistics yet.')
  setText('stats-entry-count', '0 entries')
  setText('metadata-format', '—')
  setText('session-summary', 'No subtitle session loaded.')
}

function setMedia(key) {
  state.mediaKey = key
  state.dashPlayer?.reset?.()
  state.dashPlayer = null
  ttmlRenderingDiv.replaceChildren()
  ttmlRenderingDiv.removeAttribute('style')
  video.pause()
  video.removeAttribute('src')
  video.load()

  if (key === 'live') {
    setText('media-badge', 'DVB live media')
    setText('media-note', 'DVB Live-Linear AVC DASH test stream.')
    if (window.dashjs?.MediaPlayer) {
      const dashPlayer = window.dashjs.MediaPlayer().create()
      dashPlayer.initialize(video, undefined, false)
      dashPlayer.attachTTMLRenderingDiv(ttmlRenderingDiv)
      dashPlayer.attachSource(LIVE_MPD_URL)
      state.dashPlayer = dashPlayer
      setStatus('Live media ready; press play.', 'ready')
    } else {
      video.src = LIVE_MPD_URL
      video.load()
      setStatus('dash.js unavailable; native DASH may not play in this browser.')
    }
    return
  }

  setText('media-badge', 'CC0 media')
  setText('media-note', 'Short CC0 clip from MDN’s media examples.')
  video.src = FLOWER_URL
  video.load()
}

async function exportCurrentFrame() {
  if (!state.opened) {
    setText('export-status', 'No low-level frame is open.')
    return
  }

  try {
    const raw = state.opened.renderAtTimestamp(video.currentTime) ?? state.opened.renderAtIndex(0)
    const flattened = raw ? renderFrameData(raw, { crop: 'bounds' }) : undefined
    if (!flattened) {
      setText('export-status', 'No visible cue at this time.')
      return
    }
    const blob = await toBlob(flattened, 'image/png')
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `libbitsub-${state.detectedFormat ?? 'subtitle'}-frame.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setText('export-status', `${formatBytes(blob.size)} PNG downloaded`)
  } catch (error) {
    setText('export-status', error?.message ?? String(error))
  }
}

function resetDisplaySettings() {
  const defaults = {
    'scale-range': '1',
    'opacity-range': '1',
    'bottom-range': '0',
    'horizontal-range': '0',
    'vertical-range': '0'
  }
  for (const [id, value] of Object.entries(defaults)) $(id).value = value
  $('aspect-select').value = 'stretch'
  $('align-select').value = 'center'
  applyDisplaySettings()
}

for (const id of ['scale-range', 'opacity-range', 'bottom-range', 'horizontal-range', 'vertical-range', 'aspect-select', 'align-select']) {
  $(id).addEventListener('input', applyDisplaySettings)
  $(id).addEventListener('change', applyDisplaySettings)
}

$('track-select').addEventListener('change', () => setText('track-note', TRACK_NOTES[$('track-select').value]))
$('media-select').addEventListener('change', () => setMedia($('media-select').value))
$('load-track').addEventListener('click', () => void loadTrack())
$('reset-display').addEventListener('click', resetDisplaySettings)
$('refresh-capabilities').addEventListener('click', renderCapabilities)
$('clear-events').addEventListener('click', () => {
  state.events = []
  renderEvents()
})
$('export-frame').addEventListener('click', () => void exportCurrentFrame())
$('play-toggle').addEventListener('click', () => {
  if (video.paused) void video.play()
  else video.pause()
})
$('restart-button').addEventListener('click', () => {
  video.currentTime = 0
  void video.play()
})
$('scrubber').addEventListener('pointerdown', () => { state.scrubberActive = true })
$('scrubber').addEventListener('pointerup', () => { state.scrubberActive = false })
$('scrubber').addEventListener('input', () => {
  video.currentTime = Number($('scrubber').value)
  updateInspector()
})
video.addEventListener('loadedmetadata', updateInspector)
video.addEventListener('timeupdate', updateInspector)
video.addEventListener('play', updateInspector)
video.addEventListener('pause', updateInspector)
video.addEventListener('error', () => appendDiagnostic('media', 'The video element reported a media error.'))

updateRangeOutputs()
renderCapabilities()
setMedia('flower')
setPageStatus('initializing')
void loadTrack()
setInterval(updateInspector, 400)
