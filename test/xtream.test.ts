import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeXtreamHost,
  xtreamFromM3uUrl,
  buildXtreamUrl,
  liveStreamUrl,
  movieStreamUrl,
  episodeStreamUrl,
  mapLiveStreams,
  mapVodStreams,
  mapSeries,
  decodeXtreamText,
} from '../lib/xtream.ts'

const CREDS = { host: 'http://provider.tv:8080', username: 'joe', password: 'p@ss word' }

test('normalizeXtreamHost accepts bare hosts, trailing slashes and full urls', () => {
  assert.equal(normalizeXtreamHost('provider.tv:8080'), 'http://provider.tv:8080')
  assert.equal(normalizeXtreamHost('http://provider.tv:8080/'), 'http://provider.tv:8080')
  assert.equal(normalizeXtreamHost('https://provider.tv/get.php?x=1'), 'https://provider.tv')
  assert.throws(() => normalizeXtreamHost('   '))
})

test('a get.php playlist link is recognised as Xtream credentials', () => {
  assert.deepEqual(
    xtreamFromM3uUrl('http://provider.tv:8080/get.php?username=joe&password=secret&type=m3u_plus'),
    { host: 'http://provider.tv:8080', username: 'joe', password: 'secret' },
  )
  assert.equal(xtreamFromM3uUrl('http://provider.tv/playlist.m3u'), null)
  assert.equal(xtreamFromM3uUrl('http://provider.tv/get.php?type=m3u_plus'), null)
  assert.equal(xtreamFromM3uUrl('not a url'), null)
})

test('api urls carry the credentials and action', () => {
  const url = new URL(buildXtreamUrl(CREDS, 'get_live_streams', { category_id: 7 }))
  assert.equal(url.origin + url.pathname, 'http://provider.tv:8080/player_api.php')
  assert.equal(url.searchParams.get('username'), 'joe')
  assert.equal(url.searchParams.get('password'), 'p@ss word')
  assert.equal(url.searchParams.get('action'), 'get_live_streams')
  assert.equal(url.searchParams.get('category_id'), '7')
})

test('stream urls percent-encode credentials and honour the container', () => {
  assert.equal(liveStreamUrl(CREDS, 123), 'http://provider.tv:8080/live/joe/p%40ss%20word/123.m3u8')
  assert.equal(liveStreamUrl(CREDS, 123, 'ts'), 'http://provider.tv:8080/live/joe/p%40ss%20word/123.ts')
  assert.equal(movieStreamUrl(CREDS, 9, 'mkv'), 'http://provider.tv:8080/movie/joe/p%40ss%20word/9.mkv')
  assert.equal(episodeStreamUrl(CREDS, 55), 'http://provider.tv:8080/series/joe/p%40ss%20word/55.mp4')
})

test('live streams map to entries with category names and epg ids', () => {
  const entries = mapLiveStreams(
    [
      { name: 'BBC One', stream_id: 1, stream_icon: 'http://l/1.png', epg_channel_id: 'bbc1.uk', category_id: '5', num: 101 },
      { name: 'No EPG', stream_id: 2, epg_channel_id: null, category_id: 99 },
    ],
    CREDS,
    [{ category_id: '5', category_name: 'UK | Entertainment' }],
  )
  assert.equal(entries[0].kind, 'live')
  assert.equal(entries[0].group, 'UK | Entertainment')
  assert.equal(entries[0].tvgId, 'bbc1.uk')
  assert.equal(entries[0].chno, 101)
  assert.equal(entries[0].streamId, 1)
  assert.equal(entries[0].url, 'http://provider.tv:8080/live/joe/p%40ss%20word/1.m3u8')
  // An unknown category id must not invent a group name.
  assert.equal(entries[1].group, undefined)
  assert.equal(entries[1].tvgId, undefined)
})

test('vod streams keep the container extension and a usable rating', () => {
  const entries = mapVodStreams(
    [
      { name: 'Inception', stream_id: 9, container_extension: 'mkv', rating: '8.4', stream_icon: 'http://p/9.jpg', category_id: '2' },
      { name: 'Unrated', stream_id: 10, rating: '0' },
    ],
    CREDS,
    [{ category_id: '2', category_name: 'Movies | Sci-Fi' }],
  )
  assert.equal(entries[0].kind, 'movie')
  assert.equal(entries[0].url, 'http://provider.tv:8080/movie/joe/p%40ss%20word/9.mkv')
  assert.equal(entries[0].rating, 8.4)
  assert.equal(entries[0].poster, 'http://p/9.jpg')
  assert.equal(entries[0].group, 'Movies | Sci-Fi')
  assert.equal(entries[1].url, 'http://provider.tv:8080/movie/joe/p%40ss%20word/10.mp4')
  assert.equal(entries[1].rating, undefined)
})

test('series map to show-level entries with no playable url', () => {
  const entries = mapSeries(
    [{ series_id: 3, name: 'Dark', cover: 'http://c/3.jpg', plot: 'Time travel.', genre: 'Sci-Fi', releaseDate: '2017-12-01', rating: '8.8', category_id: '4' }],
    [{ category_id: '4', category_name: 'Series | Netflix' }],
  )
  assert.deepEqual(
    {
      kind: entries[0].kind,
      url: entries[0].url,
      show: entries[0].show,
      seriesId: entries[0].seriesId,
      year: entries[0].year,
      rating: entries[0].rating,
      group: entries[0].group,
    },
    { kind: 'series', url: '', show: 'Dark', seriesId: 3, year: '2017', rating: 8.8, group: 'Series | Netflix' },
  )
})

test('decodeXtreamText unwraps base64 and leaves plain text alone', () => {
  assert.equal(decodeXtreamText(Buffer.from('BBC News', 'utf8').toString('base64')), 'BBC News')
  assert.equal(decodeXtreamText(undefined), undefined)
  assert.equal(decodeXtreamText(''), undefined)
})
