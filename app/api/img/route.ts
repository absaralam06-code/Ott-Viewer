import { hostPolicy } from '@/lib/env'
import { ProxyError, fetchUpstream } from '@/lib/proxy'

export const runtime = 'nodejs'

/**
 * Logo and poster proxy.
 *
 * Channel logos live on arbitrary provider hosts, usually plain HTTP — which an HTTPS
 * page may not load at all. Unlike streams these are not signed: pre-signing a URL for
 * every one of a hundred thousand channels would bloat the playlist payload for images
 * most viewers never scroll past. Three things stand in for the signature: the session
 * cookie (middleware rejects anonymous callers), the same private-address screening the
 * stream proxy uses, and a hard rule that the response must be a small image.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function decodeTarget(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(Buffer.from(raw, 'base64url').toString('utf8'))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const target = decodeTarget(new URL(request.url).searchParams.get('u'))
  if (!target) return new Response('invalid image url', { status: 400 })

  try {
    const { response } = await fetchUpstream({
      target: { url: target },
      policy: hostPolicy(),
      signal: request.signal,
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok || !contentType.toLowerCase().startsWith('image/')) {
      await response.body?.cancel().catch(() => {})
      return new Response(null, { status: 404 })
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => {})
      return new Response(null, { status: 413 })
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) return new Response(null, { status: 413 })

    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        // Logos effectively never change, and these are behind the session cookie.
        'cache-control': 'private, max-age=604800, immutable',
      },
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return new Response(null, { status: 499 })
    const status = err instanceof ProxyError ? err.status : 502
    return new Response(null, { status })
  }
}
