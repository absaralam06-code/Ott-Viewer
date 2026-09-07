import { NextResponse } from 'next/server'
import { hostPolicy } from '@/lib/env'
import { ProxyError, fetchUpstream, redactUrl, DEFAULT_USER_AGENT } from '@/lib/proxy'
import { looksLikeM3U, parseM3U } from '@/lib/m3u'
import { classifyEntries } from '@/lib/classify'
import { XtreamError, importXtream, xtreamFromM3uUrl } from '@/lib/xtream'
import type { XtreamLiveExtension } from '@/lib/xtream'
import type { PlaylistEntry } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** A very large playlist is still only tens of MB; beyond this something is wrong. */
const MAX_PLAYLIST_BYTES = 256 * 1024 * 1024

interface Body {
  kind?: 'm3u-url' | 'm3u-file' | 'xtream'
  url?: string
  content?: string
  host?: string
  username?: string
  password?: string
  liveExtension?: XtreamLiveExtension
}

/** Read a response body as text with a hard byte ceiling. */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_PLAYLIST_BYTES) {
    throw new ProxyError(413, 'that playlist is too large to import')
  }
  if (!response.body) return ''
  const decoder = new TextDecoder('utf-8')
  const reader = response.body.getReader()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_PLAYLIST_BYTES) {
      await reader.cancel().catch(() => {})
      throw new ProxyError(413, 'that playlist is too large to import')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function respond(
  entries: PlaylistEntry[],
  counts: { live: number; movie: number; series: number },
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json({ entries, counts, ...extra })
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  try {
    if (body.kind === 'xtream') {
      if (!body.host || !body.username || !body.password) {
        return NextResponse.json(
          { error: 'Host, username and password are all required.' },
          { status: 400 },
        )
      }
      const creds = { host: body.host, username: body.username, password: body.password }
      const result = await importXtream(creds, body.liveExtension ?? 'm3u8')
      return respond(result.entries, result.counts, {
        title: body.host.replace(/^https?:\/\//, ''),
        epgUrls: [],
        userInfo: result.userInfo,
      })
    }

    if (body.kind === 'm3u-file') {
      if (typeof body.content !== 'string' || !body.content.trim()) {
        return NextResponse.json({ error: 'The uploaded file was empty.' }, { status: 400 })
      }
      if (!looksLikeM3U(body.content)) {
        return NextResponse.json(
          { error: 'That file does not look like an M3U playlist.' },
          { status: 400 },
        )
      }
      const parsed = parseM3U(body.content)
      const { entries, counts } = classifyEntries(parsed.entries)
      return respond(entries, counts, { title: parsed.name, epgUrls: parsed.epgUrls })
    }

    // Default: an M3U/M3U8 URL.
    if (!body.url || !/^https?:\/\//i.test(body.url.trim())) {
      return NextResponse.json(
        { error: 'Enter a playlist URL starting with http:// or https://' },
        { status: 400 },
      )
    }
    const playlistUrl = body.url.trim().replace(/\.+$/, '')

    const userAgents = [
      DEFAULT_USER_AGENT,
      'OTT Navigator/1.6.8.5',
      'VLC/3.0.20 LibVLC/3.0.20',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    ]

    let response: Response | null = null
    let finalUrl = playlistUrl
    let text = ''
    let lastErrorStatus: number | null = null

    for (const ua of userAgents) {
      try {
        const fetched = await fetchUpstream({
          target: { url: playlistUrl, headers: { userAgent: ua } },
          policy: hostPolicy(),
          signal: request.signal,
        })
        response = fetched.response
        finalUrl = fetched.finalUrl
        if (!response.ok) {
          lastErrorStatus = response.status
          continue
        }
        text = await readBounded(response)
        if (looksLikeM3U(text)) {
          break
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err
        // Try next candidate
      }
    }

    if (!response || !response.ok) {
      return NextResponse.json(
        { error: `The playlist server returned ${lastErrorStatus ?? (response ? response.status : 502)}.` },
        { status: 502 },
      )
    }

    if (!looksLikeM3U(text)) {
      if (finalUrl !== playlistUrl) {
        try {
          const redirectedHost = new URL(finalUrl).hostname
          return NextResponse.json(
            {
              error: `The playlist server redirected to ${redirectedHost} which returned a non-playlist page. Check the link, or whether the subscription has expired.`,
            },
            { status: 422 },
          )
        } catch {
          // fall through
        }
      }
      return NextResponse.json(
        {
          error:
            'That URL did not return an M3U playlist. Check the link, or whether the subscription has expired.',
        },
        { status: 422 },
      )
    }

    const parsed = parseM3U(text)
    const { entries, counts } = classifyEntries(parsed.entries)
    if (!entries.length) {
      return NextResponse.json({ error: 'The playlist contained no channels.' }, { status: 422 })
    }

    // Most paid "M3U URL" links are an Xtream `get.php`. Surface that so the UI can
    // offer the richer import rather than silently switching the user's source.
    const suggestXtream = xtreamFromM3uUrl(playlistUrl)

    return respond(entries, counts, {
      title: parsed.name,
      epgUrls: parsed.epgUrls,
      suggestXtream: suggestXtream ?? undefined,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(null, { status: 499 })
    }
    if (err instanceof XtreamError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof ProxyError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[playlist] import failed', body.url ? redactUrl(body.url) : body.kind)
    return NextResponse.json({ error: 'Could not import that playlist.' }, { status: 500 })
  }
}
