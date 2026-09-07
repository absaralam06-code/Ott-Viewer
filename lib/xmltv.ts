/**
 * Incremental XMLTV parser.
 *
 * EPG files are routinely tens to hundreds of megabytes, so nothing here builds a
 * document: text is fed in as it arrives off the network and each `<channel>` or
 * `<programme>` element is consumed and discarded as soon as it completes. Two
 * filters applied during the scan — a channel-id allow-set and a time window —
 * keep both memory and the response payload bounded regardless of file size.
 *
 * This targets XMLTV specifically rather than being a general XML parser: those two
 * elements never nest, which makes a scan for the matching close tag sufficient.
 */

import type { Programme } from './types'

export interface XmltvChannel {
  id: string
  displayName?: string
  icon?: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * `20260905183000 +0100` → epoch ms. Shorter forms down to `YYYYMMDD` are accepted.
 * The offset is applied explicitly; handing these strings to `Date.parse` silently
 * misreads them, which shifts a whole guide by hours.
 */
export function parseXmltvTime(value: string): number | null {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{4}|Z)?/.exec(value)
  if (!m) return null
  const [, y, mo, d, hh, mi, ss, tz] = m
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? '0'),
    Number(mi ?? '0'),
    Number(ss ?? '0'),
  )
  if (!Number.isFinite(utc)) return null
  if (!tz || tz === 'Z') return utc
  const sign = tz[0] === '-' ? -1 : 1
  const offsetMinutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)))
  return utc - offsetMinutes * 60_000
}

/** Attributes of an opening tag. XMLTV always quotes its values. */
export function tagAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '')
  }
  return out
}

/** Compiled-once patterns. A large guide runs these hundreds of thousands of
 *  times, so building them per call shows up in profiles. */
const OPEN_TAG_CACHE = new Map<string, RegExp>()
function openTagRe(name: string): RegExp {
  let re = OPEN_TAG_CACHE.get(name)
  if (!re) {
    re = new RegExp(`<${name}(\\s[^>]*)?/?>`, 'i')
    OPEN_TAG_CACHE.set(name, re)
  }
  return re
}

const CHANNEL_START_RE = /<channel(?=[\s/>])/i
const PROGRAMME_START_RE = /<programme(?=[\s/>])/i
const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/

/** Text content of the first `<name>…</name>` child inside a block. */
function childText(block: string, name: string): string | undefined {
  const open = openTagRe(name).exec(block)
  if (!open || open.index === undefined) return undefined
  if (open[0].endsWith('/>')) return undefined
  const start = open.index + open[0].length
  const end = block.indexOf(`</${name}`, start)
  if (end === -1) return undefined
  const raw = block.slice(start, end)
  const cdata = CDATA_RE.exec(raw)
  const text = decodeEntities(cdata ? cdata[1] : raw).trim()
  return text || undefined
}

/** A named attribute of the first `<name …>` child, e.g. `<icon src="…"/>`. */
function childAttr(block: string, name: string, attr: string): string | undefined {
  const open = openTagRe(name).exec(block)
  if (!open) return undefined
  return tagAttributes(open[0])[attr]
}

export interface XmltvFilter {
  /** Keep only these channel ids. Empty or undefined keeps everything. */
  channelIds?: Set<string>
  /** Epoch ms window; programmes fully outside it are dropped. */
  from?: number
  to?: number
  /** Hard cap so a hostile or broken feed cannot exhaust memory. */
  maxProgrammes?: number
  /**
   * Called for each surviving programme. Supplying this switches the parser to
   * pure streaming mode — nothing is retained in `programmes`, which is what lets a
   * caller relay a 200 MB guide to the client without ever holding it all.
   */
  onProgramme?: (programme: Programme) => void
  onChannel?: (channel: XmltvChannel) => void
}

const DEFAULT_MAX_PROGRAMMES = 400_000

export class XmltvParser {
  readonly channels: XmltvChannel[] = []
  readonly programmes: Programme[] = []
  /** Number of programmes emitted, including any not retained. */
  count = 0
  /** Programmes seen but dropped by the filters — useful for diagnostics. */
  skipped = 0

  private buffer = ''
  private done = false
  private readonly filter: XmltvFilter
  private readonly maxProgrammes: number

  constructor(filter: XmltvFilter = {}) {
    this.filter = filter
    this.maxProgrammes = filter.maxProgrammes ?? DEFAULT_MAX_PROGRAMMES
  }

  write(chunk: string): void {
    if (this.done) return
    this.buffer += chunk
    this.drain()
  }

  end(): void {
    this.drain()
    this.buffer = ''
    this.done = true
  }

  private drain(): void {
    for (;;) {
      const next = this.nextElementStart()
      if (next === null) {
        // Retain just enough tail to catch a tag name split across chunks.
        if (this.buffer.length > 32) this.buffer = this.buffer.slice(-32)
        return
      }
      const { index, name } = next
      const openEnd = this.buffer.indexOf('>', index)
      if (openEnd === -1) {
        this.buffer = this.buffer.slice(index)
        return
      }
      // A self-closing element carries no children worth reading.
      if (this.buffer[openEnd - 1] === '/') {
        if (name === 'channel') this.addChannel(this.buffer.slice(index, openEnd + 1))
        this.buffer = this.buffer.slice(openEnd + 1)
        continue
      }
      const closeTag = `</${name}`
      const closeAt = this.buffer.indexOf(closeTag, openEnd)
      if (closeAt === -1) {
        this.buffer = this.buffer.slice(index)
        return
      }
      const closeEnd = this.buffer.indexOf('>', closeAt)
      if (closeEnd === -1) {
        this.buffer = this.buffer.slice(index)
        return
      }
      const block = this.buffer.slice(index, closeEnd + 1)
      if (name === 'channel') this.addChannel(block)
      else this.addProgramme(block)
      this.buffer = this.buffer.slice(closeEnd + 1)
    }
  }

  /** Earliest `<channel` or `<programme` opening tag in the buffer. */
  private nextElementStart(): { index: number; name: 'channel' | 'programme' } | null {
    const c = CHANNEL_START_RE.exec(this.buffer)
    const p = PROGRAMME_START_RE.exec(this.buffer)
    if (c && (!p || c.index < p.index)) return { index: c.index, name: 'channel' }
    if (p) return { index: p.index, name: 'programme' }
    return null
  }

  private addChannel(block: string): void {
    const openEnd = block.indexOf('>')
    const attrs = tagAttributes(block.slice(0, openEnd + 1))
    const id = attrs.id
    if (!id) return
    const channel: XmltvChannel = {
      id,
      displayName: childText(block, 'display-name'),
      icon: childAttr(block, 'icon', 'src'),
    }
    if (this.filter.onChannel) this.filter.onChannel(channel)
    else this.channels.push(channel)
  }

  private addProgramme(block: string): void {
    if (this.count >= this.maxProgrammes) return
    const openEnd = block.indexOf('>')
    const attrs = tagAttributes(block.slice(0, openEnd + 1))
    const channelId = attrs.channel
    if (!channelId) return
    if (this.filter.channelIds?.size && !this.filter.channelIds.has(channelId)) {
      this.skipped++
      return
    }
    const start = parseXmltvTime(attrs.start ?? '')
    if (start === null) return
    // Providers occasionally omit `stop`; assume a half-hour slot rather than drop it.
    const stop = attrs.stop ? parseXmltvTime(attrs.stop) ?? start + 1_800_000 : start + 1_800_000
    if (this.filter.to !== undefined && start > this.filter.to) {
      this.skipped++
      return
    }
    if (this.filter.from !== undefined && stop < this.filter.from) {
      this.skipped++
      return
    }
    const programme: Programme = {
      channelId,
      start,
      stop,
      title: childText(block, 'title') ?? 'No information',
      desc: childText(block, 'desc'),
      category: childText(block, 'category'),
      icon: childAttr(block, 'icon', 'src'),
      episodeNum: childText(block, 'episode-num'),
    }
    this.count++
    if (this.filter.onProgramme) this.filter.onProgramme(programme)
    else this.programmes.push(programme)
  }
}

/** Convenience wrapper for a complete in-memory document. */
export function parseXmltv(text: string, filter: XmltvFilter = {}): XmltvParser {
  const parser = new XmltvParser(filter)
  parser.write(text)
  parser.end()
  return parser
}
