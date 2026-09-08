import { NextResponse } from 'next/server'
import { proxySecret } from '@/lib/env'
import { encodeProxyTicket, encodeProxyUrl } from '@/lib/proxy'
import type { StreamHeaders } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const preferredRegion = 'bom1'

/**
 * Mint a signed `/api/stream` URL for one stream, on demand at playback time.
 *
 * Signing every entry during import would be simpler but adds roughly 150 bytes to
 * each row; across a 100k-entry playlist that is megabytes of payload and IndexedDB
 * for URLs the viewer will never open. One short request per playback is cheaper.
 */
export async function POST(request: Request) {
  let body: { url?: unknown; headers?: unknown }
  try {
    body = (await request.json()) as { url?: unknown; headers?: unknown }
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  if (typeof body.url !== 'string' || !body.url) {
    return NextResponse.json({ error: 'A stream url is required.' }, { status: 400 })
  }

  const raw = (body.headers ?? {}) as Record<string, unknown>
  const headers: StreamHeaders = {}
  for (const key of ['userAgent', 'referer', 'origin', 'cookie'] as const) {
    const value = raw[key]
    if (typeof value === 'string' && value) headers[key] = value
  }

  const clientIp =
    (typeof raw.clientIp === 'string' && raw.clientIp) ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    undefined
  if (clientIp) headers.clientIp = clientIp

  let streamUrl = body.url.trim()
  const pipeIdx = streamUrl.indexOf('|')
  if (pipeIdx !== -1) {
    const pipeParams = streamUrl.slice(pipeIdx + 1).trim()
    streamUrl = streamUrl.slice(0, pipeIdx).trim()
    if (streamUrl.endsWith('?')) streamUrl = streamUrl.slice(0, -1)
    for (const pair of pipeParams.split('&')) {
      const eq = pair.indexOf('=')
      if (eq > 0) {
        const k = pair.slice(0, eq).trim().toLowerCase()
        const v = pair.slice(eq + 1).trim()
        const tryDecode = (s: string) => {
          try {
            return decodeURIComponent(s)
          } catch {
            return s
          }
        }
        if (k === 'user-agent' && !headers.userAgent) headers.userAgent = tryDecode(v)
        else if ((k === 'referer' || k === 'referrer') && !headers.referer) headers.referer = tryDecode(v)
        else if (k === 'origin' && !headers.origin) headers.origin = tryDecode(v)
        else if (k === 'cookie' && !headers.cookie) headers.cookie = v
      }
    }
  }

  let parsed: URL
  try {
    parsed = new URL(streamUrl)
  } catch {
    return NextResponse.json({ error: 'That stream url is not valid.' }, { status: 400 })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only http and https streams are supported.' }, { status: 400 })
  }

  const streamHeaders = Object.keys(headers).length ? headers : undefined
  const secret = proxySecret()
  const src = encodeProxyUrl({ url: streamUrl, headers: streamHeaders }, secret)
  const ticket = encodeProxyTicket(parsed.origin, streamHeaders, secret)

  return NextResponse.json({
    src,
    ticket,
  })
}
