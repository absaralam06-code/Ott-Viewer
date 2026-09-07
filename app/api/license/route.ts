import { NextResponse } from 'next/server'
import { hostPolicy } from '@/lib/env'
import { assertAllowedTarget, DEFAULT_USER_AGENT, ProxyError, redactUrl } from '@/lib/proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
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

async function handleLicense(request: Request, method: 'GET' | 'POST') {
  const { searchParams } = new URL(request.url)
  const targetUrl = searchParams.get('url')
  if (!targetUrl) {
    return NextResponse.json({ error: 'License url is required' }, { status: 400, headers: CORS_HEADERS })
  }

  let targetParsed: URL
  try {
    targetParsed = new URL(targetUrl)
  } catch {
    return NextResponse.json({ error: 'Invalid license url' }, { status: 400, headers: CORS_HEADERS })
  }

  try {
    await assertAllowedTarget(targetParsed, hostPolicy())

    const clientIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip')?.trim() ||
      undefined

    const headers: Record<string, string> = {
      'Accept': '*/*',
    }

    const reqContentType = request.headers.get('content-type') || 'application/json'
    if (method === 'POST') {
      headers['Content-Type'] = reqContentType
    }

    const lowerTarget = targetUrl.toLowerCase()
    if (lowerTarget.includes('hotstar')) {
      headers['User-Agent'] = 'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'
      headers['Origin'] = 'https://www.hotstar.com'
      headers['Referer'] = 'https://www.hotstar.com/'
    } else if (lowerTarget.includes('jio')) {
      headers['User-Agent'] = 'plaYtv/7.1.3 (Linux;Android 11) ExoPlayerLib/2.11.7'
      headers['Origin'] = 'https://www.jiotv.com'
      headers['Referer'] = 'https://www.jiotv.com/'
    } else {
      headers['User-Agent'] = DEFAULT_USER_AGENT
    }

    if (clientIp) {
      headers['x-forwarded-for'] = clientIp
      headers['x-real-ip'] = clientIp
    }

    let body = method === 'POST' ? await request.arrayBuffer() : undefined

    let upstreamRes = await fetch(targetParsed, {
      method,
      headers,
      body,
      signal: request.signal,
    })

    // Fallback: If GET failed with 405 or 500 (e.g. servers that require POST body), retry with POST
    if (method === 'GET' && upstreamRes.status >= 400) {
      try {
        const retryHeaders = { ...headers, 'Content-Type': 'application/json' }
        const retryRes = await fetch(targetParsed, {
          method: 'POST',
          headers: retryHeaders,
          body: Buffer.from('{}'),
          signal: request.signal,
        })
        if (retryRes.ok) {
          upstreamRes = retryRes
        }
      } catch {
        // keep original upstreamRes
      }
    }

    const data = await upstreamRes.arrayBuffer()
    const resContentType = upstreamRes.headers.get('content-type') || 'application/json'

    // Unwrap ClearKey keys if wrapped inside base64 object (e.g. JokerTV format: { base64: { keys: [...] } })
    try {
      const text = new TextDecoder('utf-8').decode(data)
      const parsed = JSON.parse(text)
      if (parsed.base64 && Array.isArray(parsed.base64.keys)) {
        const unwrapped = JSON.stringify({
          keys: parsed.base64.keys,
          type: parsed.base64.type || 'temporary',
        })
        return new NextResponse(unwrapped, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        })
      }
    } catch {
      // not JSON or parse error, forward raw data below
    }

    return new NextResponse(data, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': resContentType,
        ...CORS_HEADERS,
      },
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(null, { status: 499, headers: CORS_HEADERS })
    }
    const status = err instanceof ProxyError ? err.status : 502
    const message = err instanceof ProxyError ? err.message : 'License request failed'
    console.error(`[license] ${message} for ${redactUrl(targetUrl)}:`, err)
    return NextResponse.json({ error: message }, { status, headers: CORS_HEADERS })
  }
}

export async function POST(request: Request) {
  return handleLicense(request, 'POST')
}

export async function GET(request: Request) {
  return handleLicense(request, 'GET')
}
