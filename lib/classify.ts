import type { MediaKind, PlaylistEntry, RawEntry } from './types'

/**
 * Plain M3U carries no field saying whether a line is a live channel, a film or a
 * series episode — OTT-style apps infer it. These heuristics run in a fixed
 * precedence order, strongest signal first, because provider playlists contradict
 * themselves constantly (a `.mkv` file inside a group called "LIVE | SPORTS", a
 * `/movie/` path with a `-1` duration, and so on).
 */

const VOD_EXTENSIONS = /\.(mp4|mkv|avi|m4v|mov|flv|wmv|mpg|mpeg|webm|3gp|ogv)$/i
const LIVE_EXTENSIONS = /\.(m3u8|ts|mpd)$/i
const MOVIE_GROUP = /\b(vod|movie|movies|film|filme|filmes|films|cinema|pel[íi]culas|kino)\b/i
const SERIES_GROUP = /\b(series|serie|s[ée]ries|shows|tv\s*show|novelas|dizi|temporada)\b/i

/** `S01E02`, `s1 e2`, `S01.E02`. */
const SE_MARKER = /\b[sS](\d{1,3})[\s._-]*[eE](\d{1,3})\b/
/** `1x02`, `01x002`. */
const X_MARKER = /\b(\d{1,3})[xX](\d{1,3})\b/
/** `Season 1 Episode 2`. */
const WORDY_MARKER = /\bseason\s*(\d{1,3})\s*(?:,|-|–)?\s*episode\s*(\d{1,3})\b/i

export interface EpisodeInfo {
  show: string
  season: number
  episode: number
  /** Whatever followed the marker, e.g. the episode's own title. */
  episodeTitle?: string
}

/** Pull `show` / `season` / `episode` out of a title, or return null if absent. */
export function parseEpisode(name: string): EpisodeInfo | null {
  for (const re of [SE_MARKER, X_MARKER, WORDY_MARKER]) {
    const m = re.exec(name)
    if (!m || m.index === undefined) continue
    const season = Number(m[1])
    const episode = Number(m[2])
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue
    const show = trimSeparators(name.slice(0, m.index))
    const episodeTitle = trimSeparators(name.slice(m.index + m[0].length))
    return {
      show: show || trimSeparators(name.replace(m[0], '')) || name,
      season,
      episode,
      episodeTitle: episodeTitle || undefined,
    }
  }
  return null
}

function trimSeparators(s: string): string {
  return s.replace(/^[\s._\-|:–—]+/, '').replace(/[\s._\-|:–—]+$/, '').trim()
}

function pathOf(url: string): string {
  const q = url.indexOf('?')
  const withoutQuery = q === -1 ? url : url.slice(0, q)
  const scheme = withoutQuery.indexOf('://')
  if (scheme === -1) return withoutQuery.toLowerCase()
  const slash = withoutQuery.indexOf('/', scheme + 3)
  return (slash === -1 ? '' : withoutQuery.slice(slash)).toLowerCase()
}

export function classifyEntry(entry: RawEntry): MediaKind {
  const path = pathOf(entry.url)
  const group = entry.group ?? ''

  // 1. Xtream-style path segments are authoritative.
  if (/(^|\/)series\//.test(path)) return 'series'
  if (/(^|\/)movies?\//.test(path)) return 'movie'

  // 2. An explicit season/episode marker in the title.
  if (parseEpisode(entry.name)) return 'series'

  // 3. What the provider called the group.
  if (SERIES_GROUP.test(group)) return 'series'
  if (MOVIE_GROUP.test(group)) return 'movie'

  // 4. A manifest extension is a strong live signal, so stop before the
  //    file-extension and duration rules, which would misread VOD-over-HLS.
  if (LIVE_EXTENSIONS.test(path)) return 'live'

  if (VOD_EXTENSIONS.test(path)) return 'movie'
  if (entry.duration > 0) return 'movie'
  return 'live'
}

/** Lowercase, strip diacritics and punctuation — used for search indexing. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ClassifiedPlaylist {
  entries: PlaylistEntry[]
  counts: { live: number; movie: number; series: number }
}

export function classifyEntries(raw: RawEntry[]): ClassifiedPlaylist {
  const counts = { live: 0, movie: 0, series: 0 }
  const entries: PlaylistEntry[] = new Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    const kind = classifyEntry(entry)
    counts[kind]++
    if (kind === 'series') {
      const info = parseEpisode(entry.name)
      entries[i] = info
        ? { ...entry, kind, show: info.show, season: info.season, episode: info.episode }
        : { ...entry, kind, show: entry.name }
    } else {
      entries[i] = { ...entry, kind }
    }
  }
  return { entries, counts }
}
