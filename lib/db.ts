'use client'

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Channel, HistoryItem, MediaKind, Playlist, PlaylistEntry, Programme } from './types'

/**
 * Browser-side storage.
 *
 * IndexedDB rather than localStorage because a single paid playlist routinely holds
 * 100,000+ entries and an XMLTV guide several hundred thousand programmes — orders of
 * magnitude past localStorage's ~5 MB quota. Everything the UI shows is read through
 * cursors and indexes; the full channel set is never held in React state.
 */

export const UNGROUPED = 'Ungrouped'

/** Upper bound for an "any string" segment of a compound key. Built from a char code
 *  rather than written literally so the source stays ASCII. */
const MAX_KEY = String.fromCharCode(0xffff)

interface OttSchema extends DBSchema {
  playlists: {
    key: string
    value: Playlist
  }
  channels: {
    key: string
    value: Channel
    indexes: {
      'by-playlist': string
      /** Drives the live/movies/series pages. */
      'by-kind': [string, MediaKind]
      /** Drives the group sidebar and group filtering. */
      'by-group': [string, MediaKind, string]
      /** Prefix search: a bounded cursor over sorted names, not a full scan. */
      'by-name': [string, string]
      /** Maps EPG channel ids back to channels. */
      'by-tvg': [string, string]
      /** Groups series episodes under their show. */
      'by-show': [string, string]
    }
  }
  epg: {
    key: [string, number]
    value: Programme
    indexes: { 'by-channel': string }
  }
  epgSources: {
    key: string
    value: { url: string; refreshedAt: number; programmes: number }
  }
  favorites: {
    key: string
    value: { channelId: string; addedAt: number }
  }
  history: {
    key: string
    value: HistoryItem
    indexes: { 'by-time': number }
  }
  settings: {
    key: string
    value: { key: string; value: unknown }
  }
}

const DB_NAME = 'ott'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<OttSchema>> | null = null

export function db(): Promise<IDBPDatabase<OttSchema>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is only available in the browser.'))
  }
  dbPromise ??= openDB<OttSchema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('playlists', { keyPath: 'id' })

      const channels = database.createObjectStore('channels', { keyPath: 'id' })
      channels.createIndex('by-playlist', 'playlistId')
      channels.createIndex('by-kind', ['playlistId', 'kind'])
      channels.createIndex('by-group', ['playlistId', 'kind', 'group'])
      channels.createIndex('by-name', ['playlistId', 'nameLower'])
      channels.createIndex('by-tvg', ['playlistId', 'tvgId'])
      channels.createIndex('by-show', ['playlistId', 'show'])

      const epg = database.createObjectStore('epg', { keyPath: ['channelId', 'start'] })
      epg.createIndex('by-channel', 'channelId')

      database.createObjectStore('epgSources', { keyPath: 'url' })
      database.createObjectStore('favorites', { keyPath: 'channelId' })

      const history = database.createObjectStore('history', { keyPath: 'channelId' })
      history.createIndex('by-time', 'watchedAt')

      database.createObjectStore('settings', { keyPath: 'key' })
    },
  })
  return dbPromise
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export async function listPlaylists(): Promise<Playlist[]> {
  const all = await (await db()).getAll('playlists')
  return all.sort((a, b) => a.addedAt - b.addedAt)
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
  return (await db()).get('playlists', id)
}

export async function savePlaylist(playlist: Playlist): Promise<void> {
  await (await db()).put('playlists', playlist)
}

/** Removes the playlist and every row that belongs to it. */
export async function deletePlaylist(id: string): Promise<void> {
  const database = await db()
  await database.delete('playlists', id)

  const tx = database.transaction('channels', 'readwrite')
  const index = tx.store.index('by-playlist')
  let cursor = await index.openCursor(IDBKeyRange.only(id))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

const CHUNK = 4_000

/**
 * Replace a playlist's rows. Written in chunks: one transaction over 100k puts holds
 * the store locked long enough to stall the UI, and chunking gives the caller a
 * progress signal for the import screen.
 */
export async function replaceChannels(
  playlistId: string,
  entries: PlaylistEntry[],
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const database = await db()

  const clear = database.transaction('channels', 'readwrite')
  let cursor = await clear.store.index('by-playlist').openCursor(IDBKeyRange.only(playlistId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await clear.done

  for (let offset = 0; offset < entries.length; offset += CHUNK) {
    const slice = entries.slice(offset, offset + CHUNK)
    const tx = database.transaction('channels', 'readwrite')
    for (let i = 0; i < slice.length; i++) {
      // Requests are fired without awaiting each one; `tx.done` settles them all.
      void tx.store.put(toChannel(playlistId, slice[i], offset + i))
    }
    await tx.done
    onProgress?.(Math.min(offset + CHUNK, entries.length), entries.length)
  }
}

/**
 * `group` is defaulted rather than left undefined: IndexedDB omits records with a
 * missing indexed field, so an ungrouped channel would otherwise be invisible to every
 * group query.
 */
function toChannel(playlistId: string, entry: PlaylistEntry, index: number): Channel {
  return {
    ...entry,
    id: `${playlistId}:${index}`,
    playlistId,
    group: entry.group || UNGROUPED,
    nameLower: normalizeForSearch(entry.name),
  }
}

/** Mirrors `classify.normalizeName`; duplicated so this module stays browser-only. */
export function normalizeForSearch(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Channel queries
// ---------------------------------------------------------------------------

export async function getChannel(id: string): Promise<Channel | undefined> {
  return (await db()).get('channels', id)
}

export async function countByKind(playlistId: string, kind: MediaKind): Promise<number> {
  return (await db()).countFromIndex('channels', 'by-kind', IDBKeyRange.only([playlistId, kind]))
}

/**
 * Distinct group names for one kind, with their channel counts.
 *
 * One key-only cursor pass tallies both. The obvious alternative — walk distinct keys
 * with `nextunique` and `count()` each — would await a second transaction inside the
 * first cursor's loop, and IndexedDB auto-commits a transaction as soon as its
 * microtask queue drains, so the outer cursor would die part-way through.
 */
export async function groupsFor(
  playlistId: string,
  kind: MediaKind,
): Promise<{ name: string; count: number }[]> {
  const database = await db()
  const counts = new Map<string, number>()

  let cursor = await database
    .transaction('channels')
    .store.index('by-group')
    .openKeyCursor(IDBKeyRange.bound([playlistId, kind, ''], [playlistId, kind, MAX_KEY]))
  while (cursor) {
    const name = String(cursor.key[2] || UNGROUPED)
    counts.set(name, (counts.get(name) ?? 0) + 1)
    cursor = await cursor.continue()
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface ChannelQuery {
  playlistId: string
  kind: MediaKind
  group?: string
  /** Free-text search over the normalised name. */
  search?: string
  favoritesOnly?: boolean
  offset?: number
  limit?: number
}

/**
 * A page of channels.
 *
 * One cursor pass, chosen to be as narrow as the filters allow: a group filter uses the
 * `by-group` range, otherwise `by-kind`. Search walks `by-name` — already sorted, so no
 * post-sort — and ranks whole-word prefix hits above mid-word ones in that same pass.
 */
export async function queryChannels(query: ChannelQuery): Promise<{ rows: Channel[]; total: number }> {
  const { playlistId, kind, group, favoritesOnly } = query
  const offset = query.offset ?? 0
  const limit = query.limit ?? 200
  const database = await db()
  const search = query.search ? normalizeForSearch(query.search) : ''

  // Resolved before the cursor opens: awaiting another transaction mid-cursor would
  // let this one auto-commit.
  const favorites = favoritesOnly ? new Set(await favoriteIds()) : null

  const store = database.transaction('channels').store
  let cursor
  if (search) {
    cursor = await store.index('by-name').openCursor(IDBKeyRange.bound([playlistId, ''], [playlistId, MAX_KEY]))
  } else if (group) {
    cursor = await store.index('by-group').openCursor(IDBKeyRange.only([playlistId, kind, group]))
  } else {
    cursor = await store.index('by-kind').openCursor(IDBKeyRange.only([playlistId, kind]))
  }

  const exact: Channel[] = []
  const partial: Channel[] = []
  let total = 0
  const ceiling = offset + limit

  while (cursor) {
    const row = cursor.value
    const matches =
      row.kind === kind &&
      (!group || row.group === group) &&
      (!favorites || favorites.has(row.id)) &&
      (!search || row.nameLower.includes(search))
    if (matches) {
      total++
      if (!search) {
        if (total > offset && exact.length < limit) exact.push(row)
      } else if (exact.length + partial.length < ceiling) {
        // `startsWith` covers a leading match; the space test covers a later word,
        // which is what makes searching "hd" find "Sky Sports HD".
        const strong = row.nameLower.startsWith(search) || row.nameLower.includes(` ${search}`)
        ;(strong ? exact : partial).push(row)
      }
    }
    cursor = await cursor.continue()
  }

  const rows = search ? [...exact, ...partial].slice(offset, ceiling) : exact
  return { rows, total }
}

/** Every distinct show in the series section, one representative row each. */
export async function listShows(playlistId: string): Promise<Channel[]> {
  const database = await db()
  const shows = new Map<string, Channel>()
  let cursor = await database
    .transaction('channels')
    .store.index('by-kind')
    .openCursor(IDBKeyRange.only([playlistId, 'series' as MediaKind]))
  while (cursor) {
    const row = cursor.value
    const key = row.show || row.name
    // Prefer the row that carries artwork, so a show with one enriched entry
    // does not show a blank poster.
    const existing = shows.get(key)
    if (!existing || (!existing.poster && row.poster)) shows.set(key, row)
    cursor = await cursor.continue()
  }
  return [...shows.values()].sort((a, b) => a.nameLower.localeCompare(b.nameLower))
}

export async function episodesOf(playlistId: string, show: string): Promise<Channel[]> {
  const rows = await (await db()).getAllFromIndex(
    'channels',
    'by-show',
    IDBKeyRange.only([playlistId, show]),
  )
  return rows.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))
}

/** All tvg-ids in a playlist — sent to `/api/epg` so the guide download is filtered. */
export async function tvgIdsFor(playlistId: string): Promise<string[]> {
  const database = await db()
  const ids = new Set<string>()
  let cursor = await database
    .transaction('channels')
    .store.index('by-tvg')
    .openKeyCursor(IDBKeyRange.bound([playlistId, ''], [playlistId, '￿']), 'nextunique')
  while (cursor) {
    const id = cursor.key[1]
    if (id) ids.add(String(id))
    cursor = await cursor.continue()
  }
  return [...ids]
}

export async function channelsWithTvgId(playlistId: string, tvgId: string): Promise<Channel[]> {
  return (await db()).getAllFromIndex('channels', 'by-tvg', IDBKeyRange.only([playlistId, tvgId]))
}

// ---------------------------------------------------------------------------
// EPG
// ---------------------------------------------------------------------------

/** Longest programme allowed to overlap the window start (a day-long marathon). */
const MAX_PROGRAMME_MS = 12 * 60 * 60 * 1000

export async function putProgrammes(programmes: Programme[]): Promise<void> {
  if (!programmes.length) return
  const database = await db()
  for (let offset = 0; offset < programmes.length; offset += CHUNK) {
    const tx = database.transaction('epg', 'readwrite')
    for (const p of programmes.slice(offset, offset + CHUNK)) void tx.store.put(p)
    await tx.done
  }
}

/**
 * Programmes overlapping `[from, to]`. The lower bound reaches back by
 * `MAX_PROGRAMME_MS` because a programme that started earlier can still be on air.
 */
export async function programmesFor(channelId: string, from: number, to: number): Promise<Programme[]> {
  const rows = await (await db()).getAll(
    'epg',
    IDBKeyRange.bound([channelId, from - MAX_PROGRAMME_MS], [channelId, to]),
  )
  return rows.filter((p) => p.stop > from && p.start < to)
}

export async function programmesForMany(
  channelIds: string[],
  from: number,
  to: number,
): Promise<Map<string, Programme[]>> {
  const out = new Map<string, Programme[]>()
  // Sequential on purpose: dozens of parallel IndexedDB reads are slower than a
  // single cursor pass per channel, and the guide only ever asks for a screenful.
  for (const id of channelIds) out.set(id, await programmesFor(id, from, to))
  return out
}

export async function nowNext(channelId: string, at = Date.now()): Promise<{ now?: Programme; next?: Programme }> {
  const rows = await programmesFor(channelId, at, at + 6 * 60 * 60 * 1000)
  rows.sort((a, b) => a.start - b.start)
  return {
    now: rows.find((p) => p.start <= at && p.stop > at),
    next: rows.find((p) => p.start > at),
  }
}

/** Drop programmes that have finished, so the store does not grow without bound. */
export async function pruneEpg(before = Date.now() - 12 * 60 * 60 * 1000): Promise<number> {
  const database = await db()
  const tx = database.transaction('epg', 'readwrite')
  let removed = 0
  let cursor = await tx.store.openCursor()
  while (cursor) {
    if (cursor.value.stop < before) {
      await cursor.delete()
      removed++
    }
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}

export async function clearEpg(): Promise<void> {
  const database = await db()
  await database.clear('epg')
  await database.clear('epgSources')
}

export async function recordEpgSource(url: string, programmes: number): Promise<void> {
  await (await db()).put('epgSources', { url, refreshedAt: Date.now(), programmes })
}

export async function listEpgSources(): Promise<{ url: string; refreshedAt: number; programmes: number }[]> {
  return (await db()).getAll('epgSources')
}

// ---------------------------------------------------------------------------
// Favorites, history, settings
// ---------------------------------------------------------------------------

export async function favoriteIds(): Promise<string[]> {
  return (await db()).getAllKeys('favorites')
}

export async function isFavorite(channelId: string): Promise<boolean> {
  return (await (await db()).getKey('favorites', channelId)) !== undefined
}

export async function toggleFavorite(channelId: string): Promise<boolean> {
  const database = await db()
  if (await database.getKey('favorites', channelId)) {
    await database.delete('favorites', channelId)
    return false
  }
  await database.put('favorites', { channelId, addedAt: Date.now() })
  return true
}

export async function favoriteChannels(): Promise<Channel[]> {
  const database = await db()
  const ids = await database.getAllKeys('favorites')
  const rows = await Promise.all(ids.map((id) => database.get('channels', id)))
  return rows.filter((row): row is Channel => row !== undefined)
}

const HISTORY_LIMIT = 60

export async function recordWatch(item: HistoryItem): Promise<void> {
  const database = await db()
  await database.put('history', item)

  const keys = await database.getAllKeysFromIndex('history', 'by-time')
  if (keys.length > HISTORY_LIMIT) {
    const tx = database.transaction('history', 'readwrite')
    for (const key of keys.slice(0, keys.length - HISTORY_LIMIT)) void tx.store.delete(key)
    await tx.done
  }
}

export async function recentlyWatched(limit = 20): Promise<HistoryItem[]> {
  const rows = await (await db()).getAllFromIndex('history', 'by-time')
  return rows.reverse().slice(0, limit)
}

export async function watchProgress(channelId: string): Promise<HistoryItem | undefined> {
  return (await db()).get('history', channelId)
}

export async function clearHistory(): Promise<void> {
  await (await db()).clear('history')
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await (await db()).get('settings', key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', { key, value })
}
