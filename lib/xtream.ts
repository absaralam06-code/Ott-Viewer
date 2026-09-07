import type { PlaylistEntry, XtreamCredentials } from './types'

/**
 * Xtream Codes client.
 *
 * Worth preferring over the same provider's plain M3U export wherever it is
 * available: the JSON API returns real categories, posters, plots and ratings, plus
 * per-channel EPG, none of which survive the flattening into an M3U file. Most paid
 * "M3U URL" subscriptions are in fact an Xtream `get.php` link, so
 * `xtreamFromM3uUrl` is used to detect and upgrade them.
 */

export type XtreamLiveExtension = 'm3u8' | 'ts'

/** Accepts `example.com:8080`, a full origin, or any URL on the server. */
export function normalizeXtreamHost(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('host is required')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  return url.origin
}

/**
 * Recognise a `get.php` playlist link and pull the Xtream credentials out of it, so
 * a pasted M3U URL can be upgraded to the richer API automatically.
 */
export function xtreamFromM3uUrl(input: string): XtreamCredentials | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (!/\/(get|player_api)\.php$/i.test(url.pathname)) return null
  const username = url.searchParams.get('username')
  const password = url.searchParams.get('password')
  if (!username || !password) return null
  return { host: url.origin, username, password }
}

export function buildXtreamUrl(
  creds: XtreamCredentials,
  action?: string,
  params?: Record<string, string | number>,
): string {
  const url = new URL('/player_api.php', normalizeXtreamHost(creds.host))
  url.searchParams.set('username', creds.username)
  url.searchParams.set('password', creds.password)
  if (action) url.searchParams.set('action', action)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v))
  return url.toString()
}

const enc = encodeURIComponent

export function liveStreamUrl(
  creds: XtreamCredentials,
  streamId: number | string,
  extension: XtreamLiveExtension = 'm3u8',
): string {
  return `${normalizeXtreamHost(creds.host)}/live/${enc(creds.username)}/${enc(creds.password)}/${streamId}.${extension}`
}

export function movieStreamUrl(
  creds: XtreamCredentials,
  streamId: number | string,
  container = 'mp4',
): string {
  return `${normalizeXtreamHost(creds.host)}/movie/${enc(creds.username)}/${enc(creds.password)}/${streamId}.${container}`
}

export function episodeStreamUrl(
  creds: XtreamCredentials,
  episodeId: number | string,
  container = 'mp4',
): string {
  return `${normalizeXtreamHost(creds.host)}/series/${enc(creds.username)}/${enc(creds.password)}/${episodeId}.${container}`
}

// ---------------------------------------------------------------------------
// Raw API shapes (only the fields actually used)
// ---------------------------------------------------------------------------

export interface XtreamCategory {
  category_id: string | number
  category_name: string
}

export interface XtreamLiveStream {
  num?: number
  name: string
  stream_id: number
  stream_icon?: string
  epg_channel_id?: string | null
  category_id?: string | number | null
  tv_archive?: number
  tv_archive_duration?: number
}

export interface XtreamVodStream {
  name: string
  stream_id: number
  stream_icon?: string
  rating?: string | number
  container_extension?: string
  category_id?: string | number | null
}

export interface XtreamSeries {
  series_id: number
  name: string
  cover?: string
  plot?: string
  genre?: string
  releaseDate?: string
  rating?: string | number
  category_id?: string | number | null
}

export interface XtreamUserInfo {
  username?: string
  status?: string
  exp_date?: string | null
  max_connections?: string
  active_cons?: string
}

export interface XtreamAuth {
  user_info?: XtreamUserInfo
  server_info?: Record<string, unknown>
}

export interface XtreamEpgListing {
  title?: string
  description?: string
  start_timestamp?: string | number
  stop_timestamp?: string | number
  start?: string
  end?: string
}

// ---------------------------------------------------------------------------
// Mapping to the app's entry shape
// ---------------------------------------------------------------------------

function categoryName(map: Map<string, string>, id: unknown): string | undefined {
  if (id === null || id === undefined) return undefined
  return map.get(String(id))
}

export function categoryMap(categories: XtreamCategory[]): Map<string, string> {
  return new Map(categories.map((c) => [String(c.category_id), c.category_name]))
}

function toRating(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function mapLiveStreams(
  streams: XtreamLiveStream[],
  creds: XtreamCredentials,
  categories: XtreamCategory[],
  extension: XtreamLiveExtension = 'm3u8',
): PlaylistEntry[] {
  const cats = categoryMap(categories)
  return streams.map((s) => ({
    kind: 'live' as const,
    name: s.name,
    url: liveStreamUrl(creds, s.stream_id, extension),
    duration: -1,
    logo: s.stream_icon || undefined,
    group: categoryName(cats, s.category_id),
    tvgId: s.epg_channel_id || undefined,
    chno: s.num,
    streamId: s.stream_id,
    catchupDays: s.tv_archive ? s.tv_archive_duration : undefined,
  }))
}

export function mapVodStreams(
  streams: XtreamVodStream[],
  creds: XtreamCredentials,
  categories: XtreamCategory[],
): PlaylistEntry[] {
  const cats = categoryMap(categories)
  return streams.map((s) => ({
    kind: 'movie' as const,
    name: s.name,
    url: movieStreamUrl(creds, s.stream_id, s.container_extension || 'mp4'),
    duration: 0,
    logo: s.stream_icon || undefined,
    poster: s.stream_icon || undefined,
    group: categoryName(cats, s.category_id),
    rating: toRating(s.rating),
    streamId: s.stream_id,
  }))
}

/**
 * Series are listed at show level only. Episode lists come from `get_series_info`,
 * which is one request per show — far too many to issue while importing a playlist,
 * so the UI fetches them when a show is opened. Show-level entries carry no `url`.
 */
export function mapSeries(
  series: XtreamSeries[],
  categories: XtreamCategory[],
): PlaylistEntry[] {
  const cats = categoryMap(categories)
  return series.map((s) => ({
    kind: 'series' as const,
    name: s.name,
    show: s.name,
    url: '',
    duration: 0,
    logo: s.cover || undefined,
    poster: s.cover || undefined,
    group: categoryName(cats, s.category_id),
    plot: s.plot || undefined,
    genre: s.genre || undefined,
    year: s.releaseDate ? s.releaseDate.slice(0, 4) : undefined,
    rating: toRating(s.rating),
    seriesId: s.series_id,
  }))
}

/** Xtream base64-encodes EPG titles and descriptions. */
export function decodeXtreamText(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    // A failed decode yields replacement characters; keep the original then.
    return decoded.includes('�') ? value : decoded
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// Network layer (server-side only — this module uses Buffer)
// ---------------------------------------------------------------------------

export class XtreamError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'XtreamError'
    this.status = status
  }
}

const REQUEST_TIMEOUT_MS = 45_000

async function request<T>(
  creds: XtreamCredentials,
  action?: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const url = buildXtreamUrl(creds, action, params)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'user-agent': 'VLC/3.0.20 LibVLC/3.0.20', accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    throw new XtreamError(502, 'could not reach the Xtream server')
  }
  if (response.status === 401 || response.status === 403) {
    throw new XtreamError(401, 'the Xtream server rejected those credentials')
  }
  if (!response.ok) {
    throw new XtreamError(502, `the Xtream server returned ${response.status}`)
  }
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    // A wrong host or an expired account typically returns an HTML error page.
    throw new XtreamError(502, 'the Xtream server did not return JSON')
  }
}

/** Validate credentials. Throws `XtreamError` when the account is unusable. */
export async function authenticate(creds: XtreamCredentials): Promise<XtreamUserInfo> {
  const auth = await request<XtreamAuth>(creds)
  const info = auth.user_info
  if (!info || (info.status && info.status.toLowerCase() !== 'active')) {
    throw new XtreamError(401, `Xtream account is not active${info?.status ? ` (${info.status})` : ''}`)
  }
  return info
}

/** Tolerate an endpoint that returns `{}` or an error object instead of a list. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export interface XtreamImport {
  userInfo: XtreamUserInfo
  entries: PlaylistEntry[]
  counts: { live: number; movie: number; series: number }
}

/**
 * Import a whole account. VOD and series categories are fetched alongside their
 * listings; a provider with those sections disabled simply yields empty arrays
 * rather than failing the whole import.
 */
export async function importXtream(
  creds: XtreamCredentials,
  extension: XtreamLiveExtension = 'm3u8',
): Promise<XtreamImport> {
  const userInfo = await authenticate(creds)

  const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p
    } catch {
      return fallback
    }
  }

  const [liveCats, liveStreams, vodCats, vodStreams, seriesCats, series] = await Promise.all([
    settle(request<unknown>(creds, 'get_live_categories'), []),
    settle(request<unknown>(creds, 'get_live_streams'), []),
    settle(request<unknown>(creds, 'get_vod_categories'), []),
    settle(request<unknown>(creds, 'get_vod_streams'), []),
    settle(request<unknown>(creds, 'get_series_categories'), []),
    settle(request<unknown>(creds, 'get_series'), []),
  ])

  const entries: PlaylistEntry[] = [
    ...mapLiveStreams(
      asArray<XtreamLiveStream>(liveStreams),
      creds,
      asArray<XtreamCategory>(liveCats),
      extension,
    ),
    ...mapVodStreams(asArray<XtreamVodStream>(vodStreams), creds, asArray<XtreamCategory>(vodCats)),
    ...mapSeries(asArray<XtreamSeries>(series), asArray<XtreamCategory>(seriesCats)),
  ]

  const counts = { live: 0, movie: 0, series: 0 }
  for (const e of entries) counts[e.kind]++
  if (!entries.length) {
    throw new XtreamError(502, 'the Xtream account returned no channels, films or series')
  }
  return { userInfo, entries, counts }
}

export interface XtreamEpisode {
  id: string
  title: string
  season: number
  episode: number
  url: string
  plot?: string
  image?: string
  durationSeconds?: number
}

interface RawEpisode {
  id?: string | number
  episode_num?: string | number
  title?: string
  container_extension?: string
  info?: { plot?: string; movie_image?: string; duration_secs?: number; duration?: string }
}

/** Episode list for one show, fetched when the user opens it. */
export async function fetchSeriesEpisodes(
  creds: XtreamCredentials,
  seriesId: number,
): Promise<{ plot?: string; cover?: string; episodes: XtreamEpisode[] }> {
  const info = await request<{
    info?: { plot?: string; cover?: string }
    episodes?: Record<string, RawEpisode[]>
  }>(creds, 'get_series_info', { series_id: seriesId })

  const episodes: XtreamEpisode[] = []
  for (const [seasonKey, list] of Object.entries(info.episodes ?? {})) {
    const season = Number(seasonKey)
    for (const raw of asArray<RawEpisode>(list)) {
      if (raw.id === undefined) continue
      episodes.push({
        id: String(raw.id),
        title: raw.title || `Episode ${raw.episode_num ?? '?'}`,
        season: Number.isFinite(season) ? season : 0,
        episode: Number(raw.episode_num ?? 0) || 0,
        url: episodeStreamUrl(creds, raw.id, raw.container_extension || 'mp4'),
        plot: raw.info?.plot,
        image: raw.info?.movie_image,
        durationSeconds: raw.info?.duration_secs,
      })
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
  return { plot: info.info?.plot, cover: info.info?.cover, episodes }
}

/** Detail for one film: plot, cast, poster, runtime. */
export async function fetchVodInfo(
  creds: XtreamCredentials,
  streamId: number,
): Promise<{ plot?: string; cover?: string; genre?: string; year?: string; cast?: string; director?: string; durationSeconds?: number }> {
  const data = await request<{
    info?: {
      plot?: string
      movie_image?: string
      cover_big?: string
      genre?: string
      releasedate?: string
      cast?: string
      director?: string
      duration_secs?: number
    }
  }>(creds, 'get_vod_info', { vod_id: streamId })
  const info = data.info ?? {}
  return {
    plot: info.plot,
    cover: info.cover_big || info.movie_image,
    genre: info.genre,
    year: info.releasedate ? info.releasedate.slice(0, 4) : undefined,
    cast: info.cast,
    director: info.director,
    durationSeconds: info.duration_secs,
  }
}

/** Now/next for one channel, used when no XMLTV source is configured. */
export async function fetchShortEpg(
  creds: XtreamCredentials,
  streamId: number,
  limit = 8,
): Promise<{ title: string; start: number; stop: number; desc?: string }[]> {
  const data = await request<{ epg_listings?: XtreamEpgListing[] }>(creds, 'get_short_epg', {
    stream_id: streamId,
    limit,
  })
  return asArray<XtreamEpgListing>(data.epg_listings)
    .map((l) => ({
      title: decodeXtreamText(l.title) ?? 'No information',
      desc: decodeXtreamText(l.description),
      start: Number(l.start_timestamp ?? 0) * 1000,
      stop: Number(l.stop_timestamp ?? 0) * 1000,
    }))
    .filter((p) => p.start > 0 && p.stop > p.start)
    .sort((a, b) => a.start - b.start)
}
