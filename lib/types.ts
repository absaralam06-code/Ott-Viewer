/** Shared domain types. Type-only, so importing this from a module that must run
 *  under `node --test` type-stripping is free — `import type` is fully erased. */

export type MediaKind = 'live' | 'movie' | 'series'

/** Per-stream request headers a provider may require. Browsers forbid scripts from
 *  setting User-Agent, so these are replayed by the server-side proxy instead. */
export interface StreamHeaders {
  userAgent?: string
  referer?: string
  origin?: string
  cookie?: string
}

export interface DrmConfig {
  type: 'clearkey'
  keyId?: string
  key?: string
  clearKeys?: Record<string, string>
  licenseUrl?: string
}

/** A playlist line as parsed, before any live/movie/series classification. */
export interface RawEntry {
  name: string
  url: string
  /** `-1` for live streams, a positive number of seconds for VOD. */
  duration: number
  logo?: string
  group?: string
  tvgId?: string
  tvgName?: string
  /** Hours to shift EPG data by, from `tvg-shift`. */
  tvgShift?: number
  /** Channel number from `tvg-chno` / `channel-number`. */
  chno?: number
  headers?: StreamHeaders
  drm?: DrmConfig
  /** Provider catch-up hints, kept so a later timeshift feature can use them. */
  catchup?: string
  catchupDays?: number
  catchupSource?: string
}

export interface PlaylistEntry extends RawEntry {
  kind: MediaKind
  /** Series only: the show title with the season/episode marker removed. */
  show?: string
  season?: number
  episode?: number
  /** Populated from Xtream metadata; M3U playlists rarely carry these. */
  poster?: string
  plot?: string
  year?: string
  rating?: number
  genre?: string
  /** Xtream numeric stream id, needed for VOD/series detail and EPG lookups. */
  streamId?: number
  seriesId?: number
}

export interface ParsedPlaylist {
  /** From `#PLAYLIST:` if present. */
  name?: string
  entries: RawEntry[]
  /** EPG sources advertised on the `#EXTM3U` line (`x-tvg-url` / `url-tvg`). */
  epgUrls: string[]
}

export type PlaylistSourceKind = 'm3u-url' | 'm3u-file' | 'xtream'

export interface XtreamCredentials {
  /** Origin only, e.g. `http://example.com:8080`. */
  host: string
  username: string
  password: string
}

export interface PlaylistSource {
  kind: PlaylistSourceKind
  /** For `m3u-url`. */
  url?: string
  /** For `xtream`. */
  xtream?: XtreamCredentials
}

/** A stored playlist. Credentials live only in the browser's IndexedDB. */
export interface Playlist {
  id: string
  title: string
  source: PlaylistSource
  epgUrls: string[]
  addedAt: number
  refreshedAt: number
  counts: { live: number; movie: number; series: number }
}

/** A stored channel/VOD/episode row. `id` is `${playlistId}:${index}`. */
export interface Channel extends PlaylistEntry {
  id: string
  playlistId: string
  /** Lowercased, accent- and punctuation-stripped name for prefix search. */
  nameLower: string
}

export interface Programme {
  channelId: string
  /** Epoch milliseconds. */
  start: number
  stop: number
  title: string
  desc?: string
  category?: string
  icon?: string
  episodeNum?: string
}

export interface HistoryItem {
  channelId: string
  playlistId: string
  name: string
  logo?: string
  kind: MediaKind
  watchedAt: number
  /** Resume position in seconds, VOD only. */
  position?: number
  duration?: number
}
