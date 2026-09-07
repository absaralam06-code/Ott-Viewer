import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { StreamHeaders } from './types'

/**
 * The stream proxy's pure logic: URL signing, SSRF screening, and HLS manifest
 * rewriting. Kept free of Next.js imports so it can be unit-tested directly.
 *
 * Why a proxy exists at all: a browser cannot play a typical IPTV stream itself.
 * Provider endpoints send no CORS headers, most are plain HTTP (which an HTTPS page
 * may not load at all), and many demand a specific User-Agent — a header scripts are
 * forbidden from setting. All three go away once the server does the fetching.
 */

export interface ProxyTarget {
  url: string
  headers?: StreamHeaders
}

export const PROXY_PATH = '/api/stream'
const MAX_REDIRECTS = 5

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Targets are signed so the endpoint can only ever fetch URLs this server itself
 * minted. Without this a public deployment is an open relay anyone can point at
 * arbitrary hosts.
 */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function encodePayload(target: ProxyTarget): string {
  const compact: { u: string; h?: StreamHeaders } = { u: target.url }
  if (target.headers && Object.keys(target.headers).length) compact.h = target.headers
  return Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url')
}

/** Build the app-relative proxy URL for a target. */
export function encodeProxyUrl(target: ProxyTarget, secret: string): string {
  const p = encodePayload(target)
  return `${PROXY_PATH}?p=${p}&s=${sign(p, secret)}`
}

/** Verify and decode a proxy URL's parameters. Returns null if tampered with. */
export function decodeProxyUrl(p: string | null, s: string | null, secret: string): ProxyTarget | null {
  if (!p || !s) return null
  const expected = Buffer.from(sign(p, secret), 'utf8')
  const given = Buffer.from(s, 'utf8')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const parsed = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as {
      u?: unknown
      h?: unknown
    }
    if (typeof parsed.u !== 'string' || !parsed.u) return null
    const url = new URL(parsed.u)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const headers = (parsed.h && typeof parsed.h === 'object' ? parsed.h : undefined) as
      | StreamHeaders
      | undefined
    return { url: parsed.u, headers }
  } catch {
    return null
  }
}

export interface StreamTicket {
  origin: string
  headers?: StreamHeaders
  exp: number
}

/** Mint a ticket allowing playback of dynamic segments for an origin for 24h. */
export function encodeProxyTicket(origin: string, headers: StreamHeaders | undefined, secret: string): { t: string; ts: string } {
  const payload: StreamTicket = {
    origin,
    headers,
    exp: Date.now() + 24 * 60 * 60 * 1000,
  }
  const t = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const ts = sign(t, secret)
  return { t, ts }
}

/** Verify and decode a stream ticket. Returns null if invalid, expired, or tampered. */
export function decodeProxyTicket(t: string | null, ts: string | null, secret: string): StreamTicket | null {
  if (!t || !ts) return null
  const expected = Buffer.from(sign(t, secret), 'utf8')
  const given = Buffer.from(ts, 'utf8')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const parsed = JSON.parse(Buffer.from(t, 'base64url').toString('utf8')) as StreamTicket
    if (!parsed.origin || typeof parsed.origin !== 'string') return null
    if (parsed.exp && parsed.exp < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Host screening
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

/** Expand an IPv6 literal to exactly 8 hextets, or null if unparseable. */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // A trailing dotted-quad (as in ::ffff:1.2.3.4) becomes two hextets.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1])
    if (v4 === null) return null
    const hi = (v4 >>> 16) & 0xffff
    const lo = v4 & 0xffff
    text = text.slice(0, dotted.index) + hi.toString(16) + ':' + lo.toString(16)
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const h of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null
      out.push(parseInt(h, 16))
    }
    return out
  }
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...new Array(fill).fill(0), ...tail]
}

/**
 * Loopback, link-local, private, CGNAT, multicast and reserved space. Blocking
 * these is what stops a signed-but-hostile playlist URL from being used to probe
 * the host's own network or a cloud metadata endpoint.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) {
    const inRange = (base: string, bits: number): boolean => {
      const baseInt = ipv4ToInt(base)
      if (baseInt === null) return false
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return ((v4 & mask) >>> 0) === ((baseInt & mask) >>> 0)
    }
    return (
      inRange('0.0.0.0', 8) ||
      inRange('10.0.0.0', 8) ||
      inRange('100.64.0.0', 10) ||
      inRange('127.0.0.0', 8) ||
      inRange('169.254.0.0', 16) ||
      inRange('172.16.0.0', 12) ||
      inRange('192.0.0.0', 24) ||
      inRange('192.0.2.0', 24) ||
      inRange('192.168.0.0', 16) ||
      inRange('198.18.0.0', 15) ||
      inRange('198.51.100.0', 24) ||
      inRange('203.0.113.0', 24) ||
      inRange('224.0.0.0', 4) ||
      inRange('240.0.0.0', 4)
    )
  }

  const h = expandIpv6(ip)
  if (!h) return false
  // IPv4-mapped (::ffff:a.b.c.d) must be judged on its embedded v4 address.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const embedded = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`
    return isPrivateAddress(embedded)
  }
  if (h.every((x) => x === 0)) return true // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true // ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** `[]` allows any public host; entries may be exact or `.suffix` wildcards. */
export function isHostAllowed(hostname: string, allowList: string[]): boolean {
  if (!allowList.length) return true
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return allowList.some((raw) => {
    const rule = raw.trim().toLowerCase()
    if (!rule) return false
    if (rule.startsWith('.')) return host === rule.slice(1) || host.endsWith(rule)
    return host === rule
  })
}

export interface HostPolicy {
  allowList: string[]
  allowPrivate: boolean
}

const dnsCache = new Map<string, { addresses: { address: string }[]; expiresAt: number }>()
const DNS_CACHE_TTL_MS = 60_000

/** Throws if the URL's host is disallowed or resolves into private space. */
export async function assertAllowedTarget(url: URL, policy: HostPolicy): Promise<void> {
  const hostname = url.hostname
  if (!isHostAllowed(hostname, policy.allowList)) {
    throw new ProxyError(403, `host not allowed: ${hostname}`)
  }
  if (policy.allowPrivate) return

  const literal = hostname.replace(/^\[|\]$/g, '')
  if (ipv4ToInt(literal) !== null || literal.includes(':')) {
    if (isPrivateAddress(literal)) throw new ProxyError(403, 'target resolves to a private address')
    return
  }

  const cached = dnsCache.get(hostname)
  let addresses: { address: string }[]
  if (cached && cached.expiresAt > Date.now()) {
    addresses = cached.addresses
  } else {
    try {
      addresses = await lookup(hostname, { all: true })
      dnsCache.set(hostname, { addresses, expiresAt: Date.now() + DNS_CACHE_TTL_MS })
    } catch {
      throw new ProxyError(502, 'could not resolve host')
    }
  }

  if (!addresses.length) throw new ProxyError(502, 'could not resolve host')
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ProxyError(403, 'target resolves to a private address')
  }
}

export class ProxyError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ProxyError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// HLS manifest rewriting
// ---------------------------------------------------------------------------

/** Tags whose `URI="…"` attribute points at another resource we must also proxy. */
const URI_TAGS = new Set([
  'EXT-X-KEY',
  'EXT-X-SESSION-KEY',
  'EXT-X-MAP',
  'EXT-X-MEDIA',
  'EXT-X-I-FRAME-STREAM-INF',
  'EXT-X-PART',
  'EXT-X-PRELOAD-HINT',
  'EXT-X-RENDITION-REPORT',
])

export function isHlsManifest(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('mpegurl')) return true
  return body.trimStart().startsWith('#EXTM3U')
}

export function isMpdManifest(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('dash+xml')) return true
  const head = body.slice(0, 500)
  return head.includes('<MPD') || head.includes('urn:mpeg:dash:schema:mpd')
}

/**
 * Ensure an MPD manifest has an absolute <BaseURL> so dynamic segment requests
 * evaluate to canonical URLs that can be proxied cleanly.
 */
export function rewriteMpdManifest(xml: string, finalUrl: string): string {
  const baseDir = new URL('.', finalUrl).href
  let updated = xml.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_match, rel) => {
    try {
      const abs = new URL(rel, finalUrl).href
      return `<BaseURL>${abs}</BaseURL>`
    } catch {
      return _match
    }
  })
  if (!updated.includes('<BaseURL>')) {
    updated = updated.replace(/<Period([^>]*)>/, `<Period$1>\n    <BaseURL>${baseDir}</BaseURL>`)
  }
  // Inject ClearKey ContentProtection if cenc is present and clearkey is missing
  if (
    updated.includes('urn:mpeg:dash:mp4protection:2011') &&
    !updated.includes('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b')
  ) {
    updated = updated.replace(
      /(<ContentProtection[^>]+schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*\/>)/g,
      `$1\n        <ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b"/>`,
    )
  }
  return updated
}

/**
 * Rewrite every URI in an HLS manifest to point back at this proxy.
 *
 * Two details matter and are the usual cause of "the master playlist loads but
 * nothing plays": relative URIs must be resolved against the manifest's **final**
 * URL after redirects rather than the URL originally requested, and `URI="…"`
 * attributes (encryption keys, init segments, alternate audio and subtitle
 * renditions) need the same treatment as bare segment lines.
 */
export function rewriteHlsManifest(
  body: string,
  finalUrl: string,
  headers: StreamHeaders | undefined,
  secret: string,
): string {
  const proxied = (raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith(PROXY_PATH)) return raw
    try {
      const absolute = new URL(trimmed, finalUrl).toString()
      return encodeProxyUrl({ url: absolute, headers }, secret)
    } catch {
      return raw
    }
  }

  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const hadCr = line.endsWith('\r')
    if (hadCr) line = line.slice(0, -1)

    if (!line.trim()) continue

    if (line.startsWith('#')) {
      const colon = line.indexOf(':')
      const tag = colon === -1 ? line.slice(1) : line.slice(1, colon)
      if (URI_TAGS.has(tag)) {
        line = line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${proxied(uri)}"`)
      }
    } else {
      line = proxied(line)
    }

    lines[i] = hadCr ? line + '\r' : line
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Upstream fetch
// ---------------------------------------------------------------------------

/** Providers commonly reject unrecognised clients or VLC, but always accept TiviMate. */
export const DEFAULT_USER_AGENT = 'TiviMate/4.7.0 (Linux; Android 11)'

export function buildUpstreamHeaders(target: ProxyTarget, range?: string | null): Headers {
  const h = new Headers()
  h.set('user-agent', target.headers?.userAgent || DEFAULT_USER_AGENT)
  h.set('accept', '*/*')
  h.set('accept-encoding', 'identity')
  if (target.headers?.referer) h.set('referer', target.headers.referer)
  if (target.headers?.origin) h.set('origin', target.headers.origin)
  if (target.headers?.cookie) h.set('cookie', target.headers.cookie)
  if (range) h.set('range', range)
  return h
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch the target, following redirects by hand so that every hop is screened —
 * an upstream 302 into `169.254.169.254` would otherwise sail straight past the
 * check done on the original URL.
 */
export async function fetchUpstream(options: {
  target: ProxyTarget
  policy: HostPolicy
  range?: string | null
  method?: 'GET' | 'HEAD'
  signal?: AbortSignal
}): Promise<{ response: Response; finalUrl: string }> {
  const { target, policy, range, method = 'GET', signal } = options
  let current: URL
  try {
    current = new URL(target.url)
  } catch {
    throw new ProxyError(400, 'invalid target url')
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertAllowedTarget(current, policy)
    let response: Response
    try {
      response = await fetch(current, {
        method,
        headers: buildUpstreamHeaders(target, range),
        redirect: 'manual',
        signal,
        cache: 'no-store',
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw new ProxyError(502, 'upstream request failed')
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) return { response, finalUrl: current.toString() }
      await response.body?.cancel().catch(() => {})
      try {
        current = new URL(location, current)
      } catch {
        throw new ProxyError(502, 'upstream sent an invalid redirect')
      }
      continue
    }
    return { response, finalUrl: current.toString() }
  }
  throw new ProxyError(502, 'too many redirects')
}

/** Strip anything that could leak provider credentials into a log or a client. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    // Xtream puts credentials in the path: /live/<user>/<pass>/<id>.ts
    const parts = u.pathname.split('/')
    if (parts.length >= 5) {
      parts[2] = '***'
      parts[3] = '***'
      u.pathname = parts.join('/')
    }
    return u.toString()
  } catch {
    return '[unparseable url]'
  }
}
