import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseXmltv, XmltvParser, parseXmltvTime, decodeEntities, tagAttributes } from '../lib/xmltv.ts'

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="bbc1.uk">
    <display-name lang="en">BBC One</display-name>
    <icon src="http://logos/bbc1.png"/>
  </channel>
  <channel id="itv1.uk">
    <display-name>ITV1</display-name>
  </channel>
  <programme start="20260905183000 +0100" stop="20260905190000 +0100" channel="bbc1.uk">
    <title lang="en">BBC News at Six</title>
    <desc lang="en">The day&apos;s news &amp; weather.</desc>
    <category lang="en">News</category>
    <icon src="http://img/news.png"/>
    <episode-num system="onscreen">S01E02</episode-num>
  </programme>
  <programme start="20260905190000 +0100" stop="20260905200000 +0100" channel="itv1.uk">
    <title>Emmerdale</title>
  </programme>
</tv>
`

test('parses channels with display names and icons', () => {
  const { channels } = parseXmltv(DOC)
  assert.deepEqual(channels, [
    { id: 'bbc1.uk', displayName: 'BBC One', icon: 'http://logos/bbc1.png' },
    { id: 'itv1.uk', displayName: 'ITV1', icon: undefined },
  ])
})

test('parses programmes, decoding entities and reading child elements', () => {
  const { programmes } = parseXmltv(DOC)
  assert.equal(programmes.length, 2)
  assert.deepEqual(programmes[0], {
    channelId: 'bbc1.uk',
    start: Date.UTC(2026, 8, 5, 17, 30, 0),
    stop: Date.UTC(2026, 8, 5, 18, 0, 0),
    title: 'BBC News at Six',
    desc: "The day's news & weather.",
    category: 'News',
    icon: 'http://img/news.png',
    episodeNum: 'S01E02',
  })
})

test('the channel-id filter drops everything else', () => {
  const { programmes, skipped } = parseXmltv(DOC, { channelIds: new Set(['itv1.uk']) })
  assert.equal(programmes.length, 1)
  assert.equal(programmes[0].channelId, 'itv1.uk')
  assert.equal(skipped, 1)
})

test('the time window drops programmes that do not overlap it', () => {
  const windowStart = Date.UTC(2026, 8, 5, 18, 30, 0)
  const { programmes } = parseXmltv(DOC, { from: windowStart, to: windowStart + 3_600_000 })
  assert.deepEqual(
    programmes.map((p) => p.title),
    ['Emmerdale'],
  )
})

test('maxProgrammes caps the result', () => {
  const { programmes } = parseXmltv(DOC, { maxProgrammes: 1 })
  assert.equal(programmes.length, 1)
})

test('output is identical when the document arrives in tiny chunks', () => {
  const whole = parseXmltv(DOC)
  const streamed = new XmltvParser()
  for (let i = 0; i < DOC.length; i += 7) streamed.write(DOC.slice(i, i + 7))
  streamed.end()
  assert.deepEqual(streamed.channels, whole.channels)
  assert.deepEqual(streamed.programmes, whole.programmes)
})

test('a chunk boundary inside a tag name is handled', () => {
  const p = new XmltvParser()
  p.write('<tv><progr')
  p.write('amme start="20260101000000 +0000" stop="20260101010000 +0000" channel="a"><ti')
  p.write('tle>Split</title></programme></tv>')
  p.end()
  assert.equal(p.programmes.length, 1)
  assert.equal(p.programmes[0].title, 'Split')
})

test('a self-closing channel element does not swallow the rest of the document', () => {
  const p = parseXmltv(
    '<tv><channel id="a"/><programme start="20260101000000 Z" channel="a"><title>T</title></programme></tv>',
  )
  assert.deepEqual(p.channels, [{ id: 'a', displayName: undefined, icon: undefined }])
  assert.equal(p.programmes.length, 1)
})

test('CDATA titles and descriptions are unwrapped', () => {
  const p = parseXmltv(
    '<tv><programme start="20260101000000 +0000" channel="a">' +
      '<title><![CDATA[Tom & Jerry <live>]]></title></programme></tv>',
  )
  assert.equal(p.programmes[0].title, 'Tom & Jerry <live>')
})

test('a missing stop time falls back to a half-hour slot', () => {
  const p = parseXmltv('<tv><programme start="20260101000000 +0000" channel="a"><title>T</title></programme></tv>')
  assert.equal(p.programmes[0].stop - p.programmes[0].start, 1_800_000)
})

test('a programme with no title still yields a placeholder rather than being dropped', () => {
  const p = parseXmltv('<tv><programme start="20260101000000 +0000" channel="a"></programme></tv>')
  assert.equal(p.programmes.length, 1)
  assert.equal(p.programmes[0].title, 'No information')
})

test('parseXmltvTime applies the offset explicitly', () => {
  assert.equal(parseXmltvTime('20260905183000 +0100'), Date.UTC(2026, 8, 5, 17, 30, 0))
  assert.equal(parseXmltvTime('20260905183000 -0430'), Date.UTC(2026, 8, 5, 23, 0, 0))
  assert.equal(parseXmltvTime('20260905183000'), Date.UTC(2026, 8, 5, 18, 30, 0))
  assert.equal(parseXmltvTime('20260905183000 Z'), Date.UTC(2026, 8, 5, 18, 30, 0))
  assert.equal(parseXmltvTime('202609051830'), Date.UTC(2026, 8, 5, 18, 30, 0))
  assert.equal(parseXmltvTime('20260905'), Date.UTC(2026, 8, 5, 0, 0, 0))
  assert.equal(parseXmltvTime('not a time'), null)
})

test('decodeEntities handles named, decimal and hex references', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2764;'), 'a & b <c> "d" \'e\' ❤')
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays')
  assert.equal(decodeEntities('no entities'), 'no entities')
})

test('tagAttributes reads single and double quoted values', () => {
  assert.deepEqual(tagAttributes(`<programme start='1' CHANNEL="a&amp;b">`), {
    start: '1',
    channel: 'a&b',
  })
})

test('callbacks stream results without retaining them', () => {
  const seenChannels: string[] = []
  const seenTitles: string[] = []
  const p = parseXmltv(DOC, {
    onChannel: (c) => seenChannels.push(c.id),
    onProgramme: (prog) => seenTitles.push(prog.title),
  })
  assert.deepEqual(seenChannels, ['bbc1.uk', 'itv1.uk'])
  assert.deepEqual(seenTitles, ['BBC News at Six', 'Emmerdale'])
  // Nothing accumulated, which is the point of the streaming mode.
  assert.equal(p.channels.length, 0)
  assert.equal(p.programmes.length, 0)
  assert.equal(p.count, 2)
})

test('maxProgrammes caps streamed output too', () => {
  const titles: string[] = []
  parseXmltv(DOC, { maxProgrammes: 1, onProgramme: (prog) => titles.push(prog.title) })
  assert.deepEqual(titles, ['BBC News at Six'])
})
