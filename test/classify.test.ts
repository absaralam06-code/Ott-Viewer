import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEntry, classifyEntries, parseEpisode, normalizeName } from '../lib/classify.ts'
import type { RawEntry } from '../lib/types.ts'

const entry = (over: Partial<RawEntry>): RawEntry => ({
  name: 'X',
  url: 'http://h/x',
  duration: -1,
  ...over,
})

test('xtream path segments decide the kind outright', () => {
  assert.equal(classifyEntry(entry({ url: 'http://h:8080/movie/u/p/123.mkv' })), 'movie')
  assert.equal(classifyEntry(entry({ url: 'http://h:8080/series/u/p/456.mp4' })), 'series')
  assert.equal(classifyEntry(entry({ url: 'http://h:8080/live/u/p/789.m3u8' })), 'live')
})

test('a season/episode marker in the title means series', () => {
  assert.equal(classifyEntry(entry({ name: 'Breaking Bad S02E05' })), 'series')
  assert.equal(classifyEntry(entry({ name: 'The Office 3x11 - Diwali' })), 'series')
})

test('group titles are used when the url and name say nothing', () => {
  assert.equal(classifyEntry(entry({ group: 'VOD | Action' })), 'movie')
  assert.equal(classifyEntry(entry({ group: 'FR - SÉRIES' })), 'series')
  assert.equal(classifyEntry(entry({ group: 'UK | ENTERTAINMENT' })), 'live')
})

test('a manifest extension outranks the file-extension and duration rules', () => {
  // Would otherwise be read as VOD because of the positive duration.
  assert.equal(classifyEntry(entry({ url: 'http://h/x.m3u8', duration: 5400 })), 'live')
  assert.equal(classifyEntry(entry({ url: 'http://h/x.mp4', duration: 5400 })), 'movie')
  assert.equal(classifyEntry(entry({ url: 'http://h/plain', duration: 5400 })), 'movie')
})

test('a group claiming LIVE does not override a /movie/ path', () => {
  assert.equal(
    classifyEntry(entry({ url: 'http://h/movie/u/p/1.mkv', group: 'LIVE | SPORTS' })),
    'movie',
  )
})

test('query strings are ignored when matching extensions', () => {
  assert.equal(classifyEntry(entry({ url: 'http://h/s/index.m3u8?token=abc.mp4' })), 'live')
})

test('parseEpisode splits show, season, episode and episode title', () => {
  assert.deepEqual(parseEpisode('Breaking Bad - S02E05 - Breakage'), {
    show: 'Breaking Bad',
    season: 2,
    episode: 5,
    episodeTitle: 'Breakage',
  })
  assert.deepEqual(parseEpisode('Friends 1x02'), {
    show: 'Friends',
    season: 1,
    episode: 2,
    episodeTitle: undefined,
  })
  assert.deepEqual(parseEpisode('Dark Season 2 Episode 8'), {
    show: 'Dark',
    season: 2,
    episode: 8,
    episodeTitle: undefined,
  })
  assert.equal(parseEpisode('BBC One HD'), null)
})

test('classifyEntries counts kinds and attaches series metadata', () => {
  const { entries, counts } = classifyEntries([
    entry({ name: 'BBC One', url: 'http://h/live/1.m3u8' }),
    entry({ name: 'Inception', url: 'http://h/movie/u/p/9.mkv' }),
    entry({ name: 'Dark S01E03 - Past and Present', url: 'http://h/series/u/p/3.mp4' }),
  ])
  assert.deepEqual(counts, { live: 1, movie: 1, series: 1 })
  assert.equal(entries[2].show, 'Dark')
  assert.equal(entries[2].season, 1)
  assert.equal(entries[2].episode, 3)
})

test('a series entry with no parseable marker still gets a show name', () => {
  const { entries } = classifyEntries([entry({ name: 'Some Show', group: 'Series' })])
  assert.equal(entries[0].kind, 'series')
  assert.equal(entries[0].show, 'Some Show')
})

test('normalizeName strips diacritics and punctuation for search', () => {
  assert.equal(normalizeName('  Canal+ Sport  (HD) '), 'canal sport hd')
  assert.equal(normalizeName('TÉLÉ-Québec'), 'tele quebec')
})
