import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeProxyUrl,
  decodeProxyUrl,
  encodeProxyTicket,
  decodeProxyTicket,
  isPrivateAddress,
  isHostAllowed,
  isHlsManifest,
  rewriteHlsManifest,
  isMpdManifest,
  rewriteMpdManifest,
  redactUrl,
  buildUpstreamHeaders,
  assertAllowedTarget,
  ProxyError,
  DEFAULT_USER_AGENT,
  PROXY_PATH,
} from '../lib/proxy.ts'

const SECRET = 'test-secret'

const params = (proxyUrl: string): URLSearchParams =>
  new URL(proxyUrl, 'http://localhost').searchParams

test('a signed target round-trips, headers included', () => {
  const url = encodeProxyUrl(
    { url: 'http://provider:8080/live/u/p/1.ts', headers: { userAgent: 'SmartTV', referer: 'http://r/' } },
    SECRET,
  )
  assert.ok(url.startsWith(`${PROXY_PATH}?p=`))
  const q = params(url)
  const decoded = decodeProxyUrl(q.get('p'), q.get('s'), SECRET)
  assert.deepEqual(decoded, {
    url: 'http://provider:8080/live/u/p/1.ts',
    headers: { userAgent: 'SmartTV', referer: 'http://r/' },
  })
})

test('a tampered payload, a wrong secret, and a missing signature are all rejected', () => {
  const q = params(encodeProxyUrl({ url: 'http://provider/a.ts' }, SECRET))
  const p = q.get('p')!
  const s = q.get('s')!
  const forged = Buffer.from(JSON.stringify({ u: 'http://evil/x' }), 'utf8').toString('base64url')

  assert.equal(decodeProxyUrl(forged, s, SECRET), null)
  assert.equal(decodeProxyUrl(p, s, 'other-secret'), null)
  assert.equal(decodeProxyUrl(p, null, SECRET), null)
  assert.equal(decodeProxyUrl(p, s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A'), SECRET), null)
})

test('non-http schemes are refused even when correctly signed', () => {
  const q = params(encodeProxyUrl({ url: 'file:///etc/passwd' }, SECRET))
  assert.equal(decodeProxyUrl(q.get('p'), q.get('s'), SECRET), null)
})

test('isPrivateAddress covers the ranges an SSRF would reach for', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`)
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`)
  }
})

test('isHostAllowed treats an empty list as open and honours dot-suffix rules', () => {
  assert.equal(isHostAllowed('anything.tv', []), true)
  assert.equal(isHostAllowed('cdn.example.com', ['.example.com']), true)
  assert.equal(isHostAllowed('example.com', ['.example.com']), true)
  assert.equal(isHostAllowed('notexample.com', ['.example.com']), false)
  assert.equal(isHostAllowed('Provider.TV', ['provider.tv']), true)
  assert.equal(isHostAllowed('other.tv', ['provider.tv']), false)
})

test('isHlsManifest detects by content type or by body', () => {
  assert.equal(isHlsManifest('application/vnd.apple.mpegurl', ''), true)
  assert.equal(isHlsManifest('audio/x-mpegurl; charset=utf-8', ''), true)
  assert.equal(isHlsManifest('text/plain', '\n#EXTM3U\n#EXT-X-VERSION:3\n'), true)
  assert.equal(isHlsManifest('video/mp2t', 'binary junk'), false)
})

test('segment lines are resolved against the final url and re-signed', () => {
  const out = rewriteHlsManifest(
    '#EXTM3U\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\n/abs/seg2.ts\n#EXTINF:6,\nhttp://other/seg3.ts\n',
    'http://cdn.example.com/hls/live/index.m3u8',
    undefined,
    SECRET,
  )
  const targets = out
    .split('\n')
    .filter((l) => l.startsWith(PROXY_PATH))
    .map((l) => {
      const q = params(l)
      return decodeProxyUrl(q.get('p'), q.get('s'), SECRET)!.url
    })
  assert.deepEqual(targets, [
    'http://cdn.example.com/hls/live/seg1.ts',
    'http://cdn.example.com/abs/seg2.ts',
    'http://other/seg3.ts',
  ])
})

test('URI attributes on keys, maps and renditions are rewritten too', () => {
  const out = rewriteHlsManifest(
    '#EXTM3U\n' +
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin",IV=0x00\n' +
      '#EXT-X-MAP:URI="init.mp4"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1000\n' +
      'v1/index.m3u8\n',
    'http://cdn.example.com/hls/live/index.m3u8',
    undefined,
    SECRET,
  )
  const uris = [...out.matchAll(/URI="([^"]*)"/g)].map((m) => m[1])
  assert.equal(uris.length, 3)
  const resolved = uris.map((u) => {
    const q = params(u)
    return decodeProxyUrl(q.get('p'), q.get('s'), SECRET)!.url
  })
  assert.deepEqual(resolved, [
    'http://cdn.example.com/hls/keys/k.bin',
    'http://cdn.example.com/hls/live/init.mp4',
    'http://cdn.example.com/hls/live/audio/en.m3u8',
  ])
  // IV and BANDWIDTH attributes must survive untouched.
  assert.ok(out.includes('IV=0x00'))
  assert.ok(out.includes('#EXT-X-STREAM-INF:BANDWIDTH=1000'))
})

test('rewriting preserves CRLF endings, blank lines and unrelated tags', () => {
  const out = rewriteHlsManifest(
    '#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n\r\n#EXTINF:6,\r\nseg.ts\r\n#EXT-X-ENDLIST\r\n',
    'http://h/p/index.m3u8',
    undefined,
    SECRET,
  )
  assert.ok(out.includes('#EXT-X-TARGETDURATION:6\r\n'))
  assert.ok(out.includes('#EXT-X-ENDLIST\r\n'))
  assert.ok(out.includes('\r\n\r\n'))
  assert.ok(out.split('\r\n').some((l) => l.startsWith(PROXY_PATH)))
})

test('stream headers are carried into every rewritten child url', () => {
  const out = rewriteHlsManifest(
    '#EXTM3U\nseg.ts\n',
    'http://h/index.m3u8',
    { userAgent: 'SmartTV/2', referer: 'http://portal/' },
    SECRET,
  )
  const line = out.split('\n').find((l) => l.startsWith(PROXY_PATH))!
  const q = params(line)
  assert.deepEqual(decodeProxyUrl(q.get('p'), q.get('s'), SECRET)!.headers, {
    userAgent: 'SmartTV/2',
    referer: 'http://portal/',
  })
})

test('an already-proxied line is left alone', () => {
  const inner = encodeProxyUrl({ url: 'http://h/seg.ts' }, SECRET)
  const out = rewriteHlsManifest(`#EXTM3U\n${inner}\n`, 'http://h/index.m3u8', undefined, SECRET)
  assert.ok(out.includes(inner))
})

test('upstream headers default to an IPTV user agent, identity encoding, and forward Range', () => {
  const h = buildUpstreamHeaders({ url: 'http://h/a.mp4' }, 'bytes=100-200')
  assert.equal(h.get('user-agent'), DEFAULT_USER_AGENT)
  assert.equal(h.get('accept-encoding'), 'identity')
  assert.equal(h.get('range'), 'bytes=100-200')
  const custom = buildUpstreamHeaders({ url: 'http://h/a', headers: { userAgent: 'Mine' } })
  assert.equal(custom.get('user-agent'), 'Mine')
  assert.equal(custom.get('accept-encoding'), 'identity')
  assert.equal(custom.get('range'), null)
})

test('redactUrl hides xtream credentials and query strings', () => {
  assert.equal(redactUrl('http://h:8080/live/joe/s3cret/123.ts'), 'http://h:8080/live/***/***/123.ts')
  assert.equal(
    redactUrl('http://h/get.php?username=joe&password=s3cret'),
    'http://h/get.php',
  )
})

test('assertAllowedTarget blocks private literals, disallowed hosts, and honours the escape hatch', async () => {
  const open = { allowList: [], allowPrivate: false }

  await assert.rejects(
    () => assertAllowedTarget(new URL('http://169.254.169.254/latest/meta-data/'), open),
    (err: unknown) => err instanceof ProxyError && err.status === 403,
  )
  await assert.rejects(
    () => assertAllowedTarget(new URL('http://[::1]:8080/x.ts'), open),
    (err: unknown) => err instanceof ProxyError && err.status === 403,
  )
  await assert.rejects(
    () => assertAllowedTarget(new URL('http://1.1.1.1/x.ts'), { allowList: ['provider.tv'], allowPrivate: false }),
    (err: unknown) => err instanceof ProxyError && err.status === 403,
  )

  // A public IP literal needs no DNS and must pass.
  await assertAllowedTarget(new URL('http://1.1.1.1/x.ts'), open)
  // The documented local-testing escape hatch.
  await assertAllowedTarget(new URL('http://192.168.1.50:8000/x.ts'), {
    allowList: [],
    allowPrivate: true,
  })
})

test('stream ticket round-trips and rejects invalid signatures or expired tickets', () => {
  const ticket = encodeProxyTicket(
    'https://cdn.example.com',
    { userAgent: 'CustomUA', cookie: 'c=1' },
    SECRET,
  )
  assert.ok(ticket.t && ticket.ts)
  const decoded = decodeProxyTicket(ticket.t, ticket.ts, SECRET)
  assert.equal(decoded?.origin, 'https://cdn.example.com')
  assert.deepEqual(decoded?.headers, { userAgent: 'CustomUA', cookie: 'c=1' })

  // Wrong secret
  assert.equal(decodeProxyTicket(ticket.t, ticket.ts, 'wrong-secret'), null)

  // Tampered payload
  assert.equal(decodeProxyTicket(ticket.t + 'x', ticket.ts, SECRET), null)
})

test('isMpdManifest detects dash manifests and rewriteMpdManifest injects BaseURL and ClearKey tag', () => {
  assert.equal(isMpdManifest('application/dash+xml', ''), true)
  assert.equal(isMpdManifest(null, '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'), true)
  assert.equal(isMpdManifest('audio/x-mpegurl', '#EXTM3U'), false)

  const xml = '<MPD><Period id="1"><BaseURL>dash/</BaseURL><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="1234"/><SegmentTemplate/></Period></MPD>'
  const rewritten = rewriteMpdManifest(xml, 'https://cdn.example.com/live/index.mpd')
  assert.ok(rewritten.includes('<BaseURL>https://cdn.example.com/live/dash/</BaseURL>'))
  assert.ok(rewritten.includes('urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'))
})

test('rewriteMpdManifest preserves query authentication tokens onto BaseURL and SegmentTemplate', () => {
  const xml = '<MPD><Period id="1"><BaseURL>dash/</BaseURL><SegmentTemplate initialization="init-$RepresentationID$.dash" media="seg-$Number$.m4s"/></Period></MPD>'
  const finalUrl = 'https://akamai.cdn.com/live/manifest.mpd?hdnea=st=123~exp=456~hmac=abc'
  const rewritten = rewriteMpdManifest(xml, finalUrl)

  assert.ok(rewritten.includes('<BaseURL>https://akamai.cdn.com/live/dash/?hdnea=st=123~exp=456~hmac=abc</BaseURL>'))
  assert.ok(rewritten.includes('initialization="init-$RepresentationID$.dash?hdnea=st=123~exp=456~hmac=abc"'))
  assert.ok(rewritten.includes('media="seg-$Number$.m4s?hdnea=st=123~exp=456~hmac=abc"'))
})

test('rewriteHlsManifest preserves query authentication tokens on relative segment URLs', () => {
  const body = '#EXTM3U\n#EXTINF:6.0,\nsegment1.ts\n#EXTINF:6.0,\nsegment2.ts'
  const finalUrl = 'https://cdn.example.com/hls/playlist.m3u8?token=xyz123'
  const rewritten = rewriteHlsManifest(body, finalUrl, undefined, SECRET)

  const lines = rewritten.split('\n')
  for (const segLine of [lines[2], lines[4]]) {
    assert.ok(segLine.startsWith('/api/stream?p='))
    const params = new URL('http://localhost' + segLine).searchParams
    const decoded = decodeProxyUrl(params.get('p'), params.get('s'), SECRET)
    assert.ok(decoded?.url.includes('token=xyz123'))
  }
})


