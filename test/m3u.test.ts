import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseM3U, parseAttributes, looksLikeM3U } from '../lib/m3u.ts'

test('parses a plain entry with the common tvg attributes', () => {
  const { entries } = parseM3U(
    '#EXTM3U\n' +
      '#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="http://x/1.png" group-title="UK",BBC One HD\n' +
      'http://host/live/1.m3u8\n',
  )
  assert.equal(entries.length, 1)
  assert.deepEqual(
    {
      name: entries[0].name,
      url: entries[0].url,
      tvgId: entries[0].tvgId,
      logo: entries[0].logo,
      group: entries[0].group,
      duration: entries[0].duration,
    },
    {
      name: 'BBC One HD',
      url: 'http://host/live/1.m3u8',
      tvgId: 'bbc1.uk',
      logo: 'http://x/1.png',
      group: 'UK',
      duration: -1,
    },
  )
})

test('a comma inside a quoted attribute does not split the title', () => {
  const { entries } = parseM3U(
    '#EXTM3U\n#EXTINF:-1 group-title="News, Sport & More" tvg-id="a",Sky News\nhttp://h/s\n',
  )
  assert.equal(entries[0].group, 'News, Sport & More')
  assert.equal(entries[0].name, 'Sky News')
})

test('tolerates a BOM, CRLF endings and no trailing newline', () => {
  const { entries } = parseM3U(
    '﻿#EXTM3U\r\n#EXTINF:-1 tvg-id="x",Channel X\r\nhttp://h/x.ts',
  )
  assert.equal(entries.length, 1)
  assert.equal(entries[0].url, 'http://h/x.ts')
  assert.equal(entries[0].name, 'Channel X')
})

test('accepts unquoted attribute values', () => {
  const { entries } = parseM3U('#EXTINF:-1 tvg-id=raw.id group-title=Sports,Raw\nhttp://h/r\n')
  assert.equal(entries[0].tvgId, 'raw.id')
  assert.equal(entries[0].group, 'Sports')
})

test('captures VLC and KODI header options for the proxy to replay', () => {
  const { entries } = parseM3U(
    '#EXTM3U\n' +
      '#EXTINF:-1,Guarded\n' +
      '#EXTVLCOPT:http-user-agent=SmartTV/1.0\n' +
      '#EXTVLCOPT:http-referrer=http://portal/\n' +
      '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi&Referer=http://k/\n' +
      'http://h/guarded\n',
  )
  assert.equal(entries[0].headers?.userAgent, 'Kodi')
  assert.equal(entries[0].headers?.referer, 'http://k/')
})

test('header options do not leak into the following entry', () => {
  const { entries } = parseM3U(
    '#EXTINF:-1,A\n#EXTVLCOPT:http-user-agent=UA-A\nhttp://h/a\n#EXTINF:-1,B\nhttp://h/b\n',
  )
  assert.equal(entries[0].headers?.userAgent, 'UA-A')
  assert.equal(entries[1].headers, undefined)
})

test('#EXTGRP supplies the group and is scoped to its own entry', () => {
  const { entries } = parseM3U(
    '#EXTINF:-1,A\n#EXTGRP:Movies\nhttp://h/a\n#EXTINF:-1,B\nhttp://h/b\n',
  )
  assert.equal(entries[0].group, 'Movies')
  assert.equal(entries[1].group, undefined)
})

test('collects EPG urls from the #EXTM3U header, including a comma-separated list', () => {
  const { epgUrls } = parseM3U(
    '#EXTM3U x-tvg-url="http://e/1.xml.gz,http://e/2.xml" url-tvg="http://e/1.xml.gz"\n',
  )
  assert.deepEqual(epgUrls, ['http://e/1.xml.gz', 'http://e/2.xml'])
})

test('reads #PLAYLIST, tvg-shift and tvg-chno', () => {
  const { name, entries } = parseM3U(
    '#EXTM3U\n#PLAYLIST:My List\n#EXTINF:-1 tvg-shift="-2" tvg-chno="101",A\nhttp://h/a\n',
  )
  assert.equal(name, 'My List')
  assert.equal(entries[0].tvgShift, -2)
  assert.equal(entries[0].chno, 101)
})

test('falls back to tvg-name, then to the url filename, when the title is missing', () => {
  const { entries } = parseM3U(
    '#EXTINF:-1 tvg-name="Fallback Name",\nhttp://h/a\n' + 'http://h/path/Some%20Movie.mp4\n',
  )
  assert.equal(entries[0].name, 'Fallback Name')
  assert.equal(entries[1].name, 'Some Movie')
})

test('keeps VOD durations and survives a stray comment between EXTINF and the url', () => {
  const { entries } = parseM3U('#EXTINF:7200 tvg-id="m",A Movie\n#SOMETHING\n\nhttp://h/m.mp4\n')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].duration, 7200)
})

test('parseAttributes ignores bare tokens without a value', () => {
  assert.deepEqual(parseAttributes('radio a=1 b="two"'), { a: '1', b: 'two' })
})

test('looksLikeM3U accepts a BOM-prefixed header and rejects html', () => {
  assert.equal(looksLikeM3U('﻿#EXTM3U\n'), true)
  assert.equal(looksLikeM3U('#EXTINF:-1,x\n'), true)
  assert.equal(looksLikeM3U('<html><body>Not a playlist'), false)
})

test('parses pipe-delimited stream headers and strips pipe from URL', () => {
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="test" group-title="Test",Test Channel
http://example.com/live/stream.m3u8|User-Agent=@myagent&Referer=https://test.com/&Origin=https://test.com&Cookie=token=123
`
  const { entries } = parseM3U(m3u)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].url, 'http://example.com/live/stream.m3u8')
  assert.deepEqual(entries[0].headers, {
    userAgent: '@myagent',
    referer: 'https://test.com/',
    origin: 'https://test.com',
    cookie: 'token=123',
  })
})

test('extracts ClearKey DRM from KODIPROP tags', () => {
  const m3u = `#EXTM3U
#EXTINF:-1 tvg-id="1132",Star Plus HD
#KODIPROP:inputstream=inputstream.adaptive
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=c6255706bca250079aeaf1fc4474d1b9:eab6217aac6f1feec103120e6218eb43
http://example.com/live/index.mpd
`
  const { entries } = parseM3U(m3u)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].url, 'http://example.com/live/index.mpd')
  assert.deepEqual(entries[0].drm, {
    type: 'clearkey',
    keyId: 'c6255706bca250079aeaf1fc4474d1b9',
    key: 'eab6217aac6f1feec103120e6218eb43',
    clearKeys: {
      c6255706bca250079aeaf1fc4474d1b9: 'eab6217aac6f1feec103120e6218eb43',
    },
  })
})

test('extracts ClearKey license server URL from KODIPROP tags', () => {
  const m3u = `#EXTM3U
#EXTINF:-1,STAR SPORTS 1 HD
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=https://hotstarlicenceurl.cstds.workers.dev/plugx|User-Agent=Hotstar
http://example.com/live/index.mpd
`
  const { entries } = parseM3U(m3u)
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].drm, {
    type: 'clearkey',
    licenseUrl: 'https://hotstarlicenceurl.cstds.workers.dev/plugx',
  })
})

