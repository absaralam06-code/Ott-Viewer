/**
 * Player engine selector.
 *
 * Runs only in the browser (dynamic imported with ssr:false).
 * Picks hls.js / mpegts.js / native depending on URL and platform.
 */

import type { DrmConfig, StreamHeaders } from './types'

export type EngineKind = 'native-hls' | 'hlsjs' | 'mpegts' | 'shaka' | 'native'

export function pickEngine(
  url: string,
  videoEl: HTMLVideoElement,
  drm?: DrmConfig,
): EngineKind {
  const lower = url.toLowerCase().split('?')[0]
  if (drm || /\.mpd(\b|$)/.test(lower) || lower.includes('.mpd')) {
    return 'shaka'
  }
  const isSafari =
    typeof navigator !== 'undefined' &&
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent)

  if (/\.(m3u8?)/.test(lower)) {
    if (isSafari && videoEl.canPlayType('application/vnd.apple.mpegurl')) return 'native-hls'
    return 'hlsjs'
  }
  if (/\.(ts|mpeg|mpg)$/.test(lower) || lower.includes('/ts') || lower.endsWith('.ts')) {
    return 'mpegts'
  }
  if (/\.(mp4|m4v|mov|webm|mkv|avi)$/.test(lower)) return 'native'
  return 'hlsjs'
}

export interface EngineHandle {
  destroy: () => void
}

export interface EngineCallbacks {
  onError?: (msg: string) => void
  onStats?: (stats: { bitrate: number; buffered: number; dropped: number }) => void
}

const RECONNECT_DELAY_MS = [2000, 4000, 8000, 16000, 30000]

export async function attachHlsJs(
  src: string,
  video: HTMLVideoElement,
  cbs: EngineCallbacks = {},
): Promise<EngineHandle> {
  const HlsModule = await import('hls.js')
  const Hls = HlsModule.default

  if (!Hls.isSupported()) {
    video.src = src
    return { destroy: () => { video.src = '' } }
  }

  let retries = 0

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 60,
  })

  hls.on(Hls.Events.ERROR, (_ev, data) => {
    if (data.fatal) {
      const msg = `HLS error: ${data.details}`
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        const delay = RECONNECT_DELAY_MS[Math.min(retries++, RECONNECT_DELAY_MS.length - 1)]
        setTimeout(() => hls.startLoad(), delay)
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError()
      } else {
        cbs.onError?.(msg)
      }
    }
  })

  hls.loadSource(src)
  hls.attachMedia(video)

  // Stats ticker
  const statTimer = setInterval(() => {
    if (!cbs.onStats) return
    const frag = hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : undefined
    const bitrate = frag?.bitrate ?? 0
    const buf = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0
    const dropped = (video as HTMLVideoElement & { webkitDroppedFrameCount?: number }).webkitDroppedFrameCount ?? 0
    cbs.onStats({ bitrate, buffered: buf, dropped })
  }, 2000)

  return {
    destroy: () => {
      clearInterval(statTimer)
      hls.destroy()
    },
  }
}

export async function attachMpegts(
  src: string,
  video: HTMLVideoElement,
  cbs: EngineCallbacks = {},
): Promise<EngineHandle> {
  const mpegts = (await import('mpegts.js')).default

  if (!mpegts.isSupported()) {
    video.src = src
    return { destroy: () => { video.src = '' } }
  }

  let retries = 0
  let player = createPlayer()

  function createPlayer() {
    const p = mpegts.createPlayer(
      { type: 'mpegts', url: src, isLive: true },
      { enableStashBuffer: false, autoCleanupSourceBuffer: true },
    )
    p.on(mpegts.Events.ERROR, (_type: string, info: { msg?: string }) => {
      const delay = RECONNECT_DELAY_MS[Math.min(retries++, RECONNECT_DELAY_MS.length - 1)]
      cbs.onError?.(`MPEG-TS error: ${info?.msg ?? 'unknown'} — reconnecting in ${delay / 1000}s`)
      setTimeout(() => {
        p.destroy()
        player = createPlayer()
        player.attachMediaElement(video)
        player.load()
        void video.play().catch(() => {})
      }, delay)
    })
    return p
  }

  player.attachMediaElement(video)
  player.load()

  return {
    destroy: () => {
      player.destroy()
    },
  }
}

export async function attachShaka(
  src: string,
  video: HTMLVideoElement,
  options: {
    drm?: DrmConfig
    ticket?: { t: string; ts: string }
    headers?: StreamHeaders
    cbs?: EngineCallbacks
  } = {},
): Promise<EngineHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shakaModule: any = await import('shaka-player/dist/shaka-player.compiled.js')
  const shaka = shakaModule.default ?? shakaModule

  shaka.polyfill.installAll()

  if (!shaka.Player.isBrowserSupported()) {
    video.src = src
    return {
      destroy: () => {
        video.src = ''
      },
    }
  }

  const player = new shaka.Player()
  await player.attach(video)

  // Configure ClearKey DRM
  if (options.drm?.licenseUrl) {
    const licenseEndpoint = `/api/license?url=${encodeURIComponent(options.drm.licenseUrl)}`
    player.configure({
      drm: {
        servers: {
          'org.w3.clearkey': licenseEndpoint,
        },
      },
    })
  } else if (options.drm?.clearKeys && Object.keys(options.drm.clearKeys).length) {
    player.configure({
      drm: {
        clearKeys: options.drm.clearKeys,
      },
    })
  } else if (options.drm?.keyId && options.drm?.key) {
    player.configure({
      drm: {
        clearKeys: {
          [options.drm.keyId]: options.drm.key,
        },
      },
    })
  }

  // Intercept segment and manifest requests to pass through /api/stream with ticket
  const ticket = options.ticket
  if (ticket) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    player.getNetworkingEngine().registerRequestFilter((type: number, request: any) => {
      // Do not intercept license requests or POST requests
      if (
        (shaka.net?.NetworkingEngine?.RequestType?.LICENSE !== undefined &&
          type === shaka.net.NetworkingEngine.RequestType.LICENSE) ||
        request.method === 'POST'
      ) {
        return
      }
      const uri = request.uris[0]
      if (
        uri &&
        !uri.startsWith('/api/stream') &&
        !uri.startsWith('/api/license') &&
        !uri.startsWith(window.location.origin + '/api/stream') &&
        !uri.startsWith(window.location.origin + '/api/license')
      ) {
        request.uris = [
          `/api/stream?t=${encodeURIComponent(ticket.t)}&ts=${encodeURIComponent(ticket.ts)}&u=${encodeURIComponent(uri)}`,
        ]
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  player.addEventListener('error', (event: any) => {
    const detail = event?.detail
    const msg = detail
      ? `Shaka error (${detail.code}): ${detail.message || detail.data?.[0] || 'stream error'}`
      : 'Shaka playback error'
    options.cbs?.onError?.(msg)
  })

  // Stats ticker
  const statTimer = setInterval(() => {
    if (!options.cbs?.onStats) return
    const stats = player.getStats?.() ?? {}
    const bitrate = stats.streamBandwidth ?? 0
    const buf = video.buffered.length
      ? video.buffered.end(video.buffered.length - 1) - video.currentTime
      : 0
    const dropped =
      stats.droppedFrames ??
      (video as HTMLVideoElement & { webkitDroppedFrameCount?: number }).webkitDroppedFrameCount ??
      0
    options.cbs.onStats({ bitrate, buffered: buf, dropped })
  }, 2000)

  await player.load(src)

  return {
    destroy: () => {
      clearInterval(statTimer)
      void player.destroy()
    },
  }
}
