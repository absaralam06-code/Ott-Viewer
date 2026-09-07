import { NextResponse } from 'next/server'
import { proxySecret } from '@/lib/env'
import { encodeProxyUrl } from '@/lib/proxy'
import {
  XtreamError,
  fetchSeriesEpisodes,
  fetchShortEpg,
  fetchVodInfo,
} from '@/lib/xtream'
import type { XtreamCredentials } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Lazily-fetched Xtream detail: episode lists, film metadata, per-channel now/next.
 *
 * These are deliberately not part of the import. `get_series_info` is one request per
 * show, so a 3,000-title series library would mean 3,000 upstream calls before the user
 * sees anything; the same reasoning applies to `get_vod_info`. They are fetched when a
 * title is opened instead.
 *
 * Credentials arrive in the request body because they live in the browser's IndexedDB
 * and are never persisted server-side. That means they are also never logged: errors
 * below report only what failed.
 */

function readCredentials(value: unknown): XtreamCredentials | null {
  if (!value || typeof value !== 'object') return null
  const { host, username, password } = value as Record<string, unknown>
  if (typeof host !== 'string' || !host) return null
  if (typeof username !== 'string' || !username) return null
  if (typeof password !== 'string' || !password) return null
  return { host, username, password }
}

function readId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

interface Body {
  action?: string
  credentials?: unknown
  seriesId?: unknown
  streamId?: unknown
  limit?: unknown
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const credentials = readCredentials(body.credentials)
  if (!credentials) {
    return NextResponse.json({ error: 'Xtream credentials are required.' }, { status: 400 })
  }

  try {
    switch (body.action) {
      case 'series': {
        const seriesId = readId(body.seriesId)
        if (seriesId === null) {
          return NextResponse.json({ error: 'A series id is required.' }, { status: 400 })
        }
        const info = await fetchSeriesEpisodes(credentials, seriesId)
        // Episodes are few enough per show that signing them here saves the client a
        // second round trip before it can start playing one.
        return NextResponse.json({
          plot: info.plot,
          cover: info.cover,
          episodes: info.episodes.map((e) => ({
            ...e,
            src: encodeProxyUrl({ url: e.url }, proxySecret()),
          })),
        })
      }

      case 'vod': {
        const streamId = readId(body.streamId)
        if (streamId === null) {
          return NextResponse.json({ error: 'A stream id is required.' }, { status: 400 })
        }
        return NextResponse.json(await fetchVodInfo(credentials, streamId))
      }

      case 'epg': {
        const streamId = readId(body.streamId)
        if (streamId === null) {
          return NextResponse.json({ error: 'A stream id is required.' }, { status: 400 })
        }
        const limit = readId(body.limit) ?? 8
        return NextResponse.json({
          listings: await fetchShortEpg(credentials, streamId, Math.min(limit, 50)),
        })
      }

      default:
        return NextResponse.json(
          { error: "action must be one of 'series', 'vod' or 'epg'." },
          { status: 400 },
        )
    }
  } catch (err) {
    if (err instanceof XtreamError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error(`[xtream] ${body.action} lookup failed`)
    return NextResponse.json({ error: 'That lookup failed.' }, { status: 502 })
  }
}
