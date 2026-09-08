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
  let testUrl = url
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
    if (parsed.searchParams.has('u')) {
      testUrl = parsed.searchParams.get('u') || url
    } else if (parsed.searchParams.has('p')) {
      const p = parsed.searchParams.get('p')
      if (p) {
        const decoded = JSON.parse(
          typeof atob !== 'undefined'
            ? atob(p.replace(/-/g, '+').replace(/_/g, '/'))
            : Buffer.from(p, 'base64url').toString('utf8')
        )
        if (decoded?.u) testUrl = decoded.u
      }
    }
  } catch {
    /* ignore */
  }

  const lower = testUrl.toLowerCase().split('?')[0]

  const hasValidLicenseUrl = Boolean(drm?.licenseUrl && /^https?:\/\//i.test(drm.licenseUrl))
  const cleanKid = (drm?.keyId || '').toLowerCase().replace(/[^0-9a-f]/g, '')
  const cleanKey = (drm?.key || '').toLowerCase().replace(/[^0-9a-f]/g, '')
  const hasValidDirectKeys = Boolean(cleanKid.length >= 16 && cleanKey.length >= 16)
  const hasValidClearKeys = Boolean(
    drm?.clearKeys &&
    Object.entries(drm.clearKeys).some(([kid, k]) => {
      const cKid = kid.toLowerCase().replace(/[^0-9a-f]/g, '')
      const cK = k.toLowerCase().replace(/[^0-9a-f]/g, '')
      return cKid.length >= 16 && cK.length >= 16
    })
  )

  const isDrmReady = hasValidLicenseUrl || hasValidDirectKeys || hasValidClearKeys
  const isDash = /\.mpd(\b|$)/.test(lower) || lower.includes('.mpd')

  if (isDrmReady || isDash) {
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
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    maxBufferHole: 0.5,
    nudgeOffset: 0.2,
    nudgeMaxRetry: 10,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 10,
  })

  hls.on(Hls.Events.ERROR, (_ev, data) => {
    if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
      // Nudge past buffer holes commonly found in restreamed IPTV
      video.currentTime += 0.1
      return
    }

    if (data.fatal) {
      const httpCode = data.response?.code
      const msg = `HLS error: ${data.details}${httpCode ? ` (HTTP ${httpCode})` : ''}`
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (retries >= 3) {
          cbs.onError?.(
            `Stream connection failed: ${data.details}${httpCode ? ` (HTTP ${httpCode})` : ''}. Stream may be offline, geo-restricted, or blocked.`
          )
        } else {
          const delay = RECONNECT_DELAY_MS[Math.min(retries++, RECONNECT_DELAY_MS.length - 1)]
          setTimeout(() => hls.startLoad(), delay)
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError()
      } else {
        cbs.onError?.(msg)
      }
    }
  })

  hls.on(Hls.Events.FRAG_LOADED, () => {
    retries = 0
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

  // Configure resilient streaming and DASH drift correction
  player.configure({
    streaming: {
      bufferingGoal: 4,
      rebufferingGoal: 1.5,
      bufferBehind: 15,
      stallEnabled: true,
      stallThreshold: 1,
      stallSkip: 0.2,
      jumpLargeGaps: true,
      alwaysStreamLookup: true,
      safeSeekOffset: 2,
    },
    manifest: {
      dash: {
        autoCorrectDrift: true,
        ignoreMinBufferTime: true,
      },
      retryParameters: {
        maxAttempts: 4,
        baseDelay: 500,
        backoffFactor: 1.5,
        fuzzFactor: 0.2,
        timeout: 8000,
      },
    },
  })

  // Configure ClearKey DRM
  const sanitizeKey = (k: string) => k.toLowerCase().replace(/[^0-9a-f]/g, '')
  const clearKeysMap: Record<string, string> = {}

  const base64UrlToHex = (str: string): string => {
    try {
      const clean = str.replace(/-/g, '+').replace(/_/g, '/')
      const padded = clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), '=')
      const bin = atob(padded)
      let hex = ''
      for (let i = 0; i < bin.length; i++) {
        hex += bin.charCodeAt(i).toString(16).padStart(2, '0')
      }
      return hex.toLowerCase()
    } catch {
      return str.replace(/[^0-9a-f]/gi, '').toLowerCase()
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  if (options.drm?.licenseUrl) {
    const licenseEndpoint = `${origin}/api/license?url=${encodeURIComponent(options.drm.licenseUrl)}`
    player.configure({
      drm: {
        servers: {
          'org.w3.clearkey': licenseEndpoint,
        },
      },
    })

    // Pre-fetch keys to populate clearKeys in Shaka, which forces ClearKey CDM and overrides Widevine
    try {
      const kidToFetch = options.drm?.keyId
      const res = await fetch(licenseEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: kidToFetch ? JSON.stringify({ kids: [kidToFetch] }) : '{}',
      })
      if (res.ok) {
        const text = await res.text()
        const parsed = JSON.parse(text)
        const keysList = Array.isArray(parsed?.keys)
          ? parsed.keys
          : Array.isArray(parsed?.base64?.keys)
          ? parsed.base64.keys
          : []
        for (const item of keysList) {
          if (item?.kid && item?.k) {
            const hexKid =
              item.kid.length === 32 && /^[0-9a-f]+$/i.test(item.kid)
                ? item.kid.toLowerCase()
                : base64UrlToHex(item.kid)
            const hexKey =
              item.k.length === 32 && /^[0-9a-f]+$/i.test(item.k)
                ? item.k.toLowerCase()
                : base64UrlToHex(item.k)
            if (hexKid.length === 32 && hexKey.length === 32) {
              clearKeysMap[hexKid] = hexKey
            }
          }
        }
      }
    } catch (e) {
      console.warn('[player] Could not pre-fetch ClearKey license keys:', e)
    }
  }

  if (options.drm?.clearKeys && Object.keys(options.drm.clearKeys).length) {
    for (const [kid, k] of Object.entries(options.drm.clearKeys)) {
      const sKid = sanitizeKey(kid)
      const sK = sanitizeKey(k)
      if (sKid.length >= 16 && sK.length >= 16) {
        clearKeysMap[sKid] = sK
      }
    }
  }

  if (options.drm?.keyId && options.drm?.key) {
    const cleanKid = sanitizeKey(options.drm.keyId)
    const cleanKey = sanitizeKey(options.drm.key)
    if (cleanKid.length >= 16 && cleanKey.length >= 16) {
      clearKeysMap[cleanKid] = cleanKey
    }
  }

  if (Object.keys(clearKeysMap).length > 0) {
    player.configure({
      drm: {
        clearKeys: clearKeysMap,
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
      let uri = request.uris[0]
      if (uri) {
        try {
          if (!/^https?:\/\//i.test(uri)) {
            uri = new URL(uri, window.location.href).href
          }
        } catch {
          // ignore
        }
        if (
          !uri.startsWith('/api/stream') &&
          !uri.startsWith('/api/license') &&
          !uri.startsWith(origin + '/api/stream') &&
          !uri.startsWith(origin + '/api/license')
        ) {
          request.uris = [
            `${origin}/api/stream?t=${encodeURIComponent(ticket.t)}&ts=${encodeURIComponent(ticket.ts)}&u=${encodeURIComponent(uri)}`,
          ]
        }
      }
    })
  }

  // Response filter to unwrap ClearKey keys if wrapped in base64 and normalize hex keys to base64url
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  player.getNetworkingEngine().registerResponseFilter((type: number, response: any) => {
    if (
      shaka.net?.NetworkingEngine?.RequestType?.LICENSE !== undefined &&
      type === shaka.net.NetworkingEngine.RequestType.LICENSE &&
      response.data
    ) {
      try {
        const text = shaka.util.StringUtils.fromUTF8(response.data)
        const parsed = JSON.parse(text)
        const keysList = Array.isArray(parsed?.keys)
          ? parsed.keys
          : Array.isArray(parsed?.base64?.keys)
          ? parsed.base64.keys
          : null
        if (keysList) {
          const hexToBase64Url = (str: string) => {
            if (typeof str === 'string' && str.length === 32 && /^[0-9a-f]+$/i.test(str)) {
              try {
                const bin = str.match(/.{2}/g)?.map((byte) => String.fromCharCode(parseInt(byte, 16))).join('') || ''
                return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
              } catch {
                return str
              }
            }
            return str
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const normalizedKeys = keysList.map((item: any) => ({
            ...item,
            kid: hexToBase64Url(item.kid),
            k: hexToBase64Url(item.k),
          }))
          const unwrapped = JSON.stringify({
            keys: normalizedKeys,
            type: parsed.type || parsed.base64?.type || 'temporary',
          })
          response.data = shaka.util.StringUtils.toUTF8(unwrapped)
        }
      } catch {
        // ignore
      }
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  player.addEventListener('error', (event: any) => {
    const detail = event?.detail
    let errorInfo = 'stream error'
    if (detail) {
      const code = detail.code
      const status = detail.data?.[1] ? ` HTTP ${detail.data[1]}` : ''
      const url = detail.data?.[0] ? ` (${detail.data[0]})` : ''
      errorInfo = `${detail.message || `Code ${code}`}${status}${url}`
    }
    const msg = `Shaka error: ${errorInfo}`
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

  try {
    const absoluteSrc = src.startsWith('/') ? `${origin}${src}` : src
    await player.load(absoluteSrc)
  } catch (err: unknown) {
    let msg = 'Failed to load stream in player'
    if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>
      const code = typeof e.code === 'number' ? ` (${e.code})` : ''
      const dataArr = Array.isArray(e.data) ? e.data : []
      const status = dataArr[1] ? ` HTTP ${dataArr[1]}` : ''
      const url = dataArr[0] ? ` [${dataArr[0]}]` : ''
      const baseMsg = typeof e.message === 'string' && e.message ? e.message : 'Shaka playback error'
      msg = `${baseMsg}${code}${status}${url}`
    } else if (err instanceof Error) {
      msg = err.message
    }
    options.cbs?.onError?.(msg)
    const errObj = new Error(msg)
    Object.assign(errObj, err)
    errObj.message = msg
    throw errObj
  }

  return {
    destroy: () => {
      clearInterval(statTimer)
      void player.destroy()
    },
  }
}
