import { hostPolicy, proxySecret } from '@/lib/env'
import {
  ProxyError,
  decodeProxyTicket,
  decodeProxyUrl,
  fetchUpstream,
  isHlsManifest,
  isMpdManifest,
  redactUrl,
  rewriteHlsManifest,
  rewriteMpdManifest,
} from '@/lib/proxy'
import type { ProxyTarget } from '@/lib/proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const preferredRegion = 'bom1'
/**
 * Serverless platforms cap function duration (60s on Vercel Hobby).
 * HLS and DASH are unaffected because each segment is its own short request.
 */
export const maxDuration = 60

/** Manifests are kilobytes; anything larger is not one and must not be buffered. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

/** Headers that describe our own connection to the provider, not the payload. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
  'access-control-allow-origin',
  'strict-transport-security',
])

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'Date, Content-Length, Content-Range, Accept-Ranges, Content-Type, Server',
}

function passThroughHeaders(source: Headers): Headers {
  const out = new Headers()
  for (const [key, value] of source) {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value)
  }
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    out.set(key, value)
  }
  return out
}

/** Cheap test for whether a body is worth buffering to look for `#EXTM3U` or `<MPD`. */
function mightBeManifest(contentType: string | null, finalUrl: string): boolean {
  try {
    const path = new URL(finalUrl).pathname
    // Binary encryption keys, media segments, images and fonts are never manifests
    if (/\.(key|ts|m4s|mp4|bin|png|jpg|jpeg|webp|woff2?|aac|mp3)$/i.test(path)) return false
    if (/\.(m3u8?|mpd)$/i.test(path)) return true
  } catch {
    /* ignore */
  }
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('mpegurl') || ct.includes('dash+xml')) return true
  if (/^(video|audio|image)\//.test(ct)) return false
  return ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct === ''
}

async function handle(request: Request, method: 'GET' | 'HEAD'): Promise<Response> {
  const url = new URL(request.url)
  const secret = proxySecret()

  let target: ProxyTarget | null = null
  if (url.searchParams.has('t') && url.searchParams.has('ts') && url.searchParams.has('u')) {
    const ticket = decodeProxyTicket(url.searchParams.get('t'), url.searchParams.get('ts'), secret)
    const targetUrl = url.searchParams.get('u')
    if (!ticket || !targetUrl) {
      return new Response('invalid or expired stream ticket', { status: 403, headers: CORS_HEADERS })
    }
    let targetParsed: URL
    try {
      targetParsed = new URL(targetUrl)
    } catch {
      return new Response('invalid target url', { status: 400, headers: CORS_HEADERS })
    }
    if (targetParsed.protocol !== 'http:' && targetParsed.protocol !== 'https:') {
      return new Response('invalid target protocol', { status: 400, headers: CORS_HEADERS })
    }

    target = { url: targetUrl, headers: ticket.headers }
  } else {
    target = decodeProxyUrl(url.searchParams.get('p'), url.searchParams.get('s'), secret)
  }

  if (!target) {
    return new Response('invalid or unsigned proxy url', { status: 403, headers: CORS_HEADERS })
  }

  // Forward viewer's client IP if not already explicitly attached
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    undefined
  if (clientIp) {
    target.headers = { ...target.headers, clientIp: target.headers?.clientIp || clientIp }
  }

  try {
    const { response, finalUrl } = await fetchUpstream({
      target,
      policy: hostPolicy(),
      range: request.headers.get('range'),
      method,
      signal: request.signal,
    })

    const headers = passThroughHeaders(response.headers)

    // Ensure Date header is exposed for Shaka live clock sync
    if (!headers.has('date')) {
      headers.set('date', new Date().toUTCString())
    }

    if (method === 'HEAD' || !response.body) {
      return new Response(null, { status: response.status, headers })
    }

    if (mightBeManifest(response.headers.get('content-type'), finalUrl)) {
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (!declared || declared <= MAX_MANIFEST_BYTES) {
        const rawBuf = await response.arrayBuffer()
        const rawBytes = new Uint8Array(rawBuf)
        const text = new TextDecoder('utf-8').decode(rawBytes)
        if (isHlsManifest(response.headers.get('content-type'), text)) {
          const rewritten = rewriteHlsManifest(text, finalUrl, target.headers, secret)
          headers.set('content-type', 'application/vnd.apple.mpegurl')
          // A live manifest is rewritten every few seconds; caching it stalls playback.
          headers.set('cache-control', 'no-store')
          return new Response(rewritten, { status: response.status, headers })
        } else if (isMpdManifest(response.headers.get('content-type'), text)) {
          const rewritten = rewriteMpdManifest(text, finalUrl)
          headers.set('content-type', 'application/dash+xml')
          headers.set('cache-control', 'no-store')
          return new Response(rewritten, { status: response.status, headers })
        }
        // Not a manifest after all — return exact raw bytes untouched!
        if (response.headers.has('content-length') && !response.headers.has('content-encoding')) {
          headers.set('content-length', response.headers.get('content-length')!)
        }
        return new Response(rawBytes, { status: response.status, headers })
      }
    }

    // Preserve media segment and key lengths / ranges if not compressed
    if (response.headers.has('content-length') && !response.headers.has('content-encoding')) {
      headers.set('content-length', response.headers.get('content-length')!)
    }
    if (response.headers.has('content-range')) {
      headers.set('content-range', response.headers.get('content-range')!)
    }

    // Cache media segments briefly to prevent buffering stutters
    if (!headers.has('cache-control')) {
      const isSegment = /\.(ts|m4s|mp4|aac|key|bin)($|\?)/i.test(finalUrl)
      if (isSegment) {
        headers.set('cache-control', 'public, max-age=60, s-maxage=60')
      } else {
        headers.set('cache-control', 'private, max-age=30')
      }
    }
    headers.set('accept-ranges', response.headers.get('accept-ranges') ?? 'bytes')
    return new Response(response.body, { status: response.status, headers })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // The viewer navigated away or zapped channels; not an error worth logging.
      return new Response(null, { status: 499, headers: CORS_HEADERS })
    }
    const status = err instanceof ProxyError ? err.status : 502
    const message = err instanceof ProxyError ? err.message : 'upstream request failed'
    console.error(`[stream] ${message} for ${redactUrl(target.url)}`)
    return new Response(message, { status, headers: CORS_HEADERS })
  }
}

export async function GET(request: Request) {
  return handle(request, 'GET')
}

export async function HEAD(request: Request) {
  return handle(request, 'HEAD')
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-max-age': '86400',
    },
  })
}
