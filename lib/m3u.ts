import type { ParsedPlaylist, RawEntry, StreamHeaders } from './types'

/**
 * Streaming-ish M3U/M3U8 playlist parser.
 *
 * Written as a single line-by-line pass rather than regexes over the whole document:
 * IPTV playlists routinely run to 100k+ lines, and a global regex over several
 * megabytes of text is both slow and prone to catastrophic backtracking.
 *
 * Tolerates the things real provider playlists actually do wrong: CRLF endings, a
 * UTF-8 BOM, unquoted attribute values, commas inside quoted attribute values, a
 * missing display title, blank lines and stray comments between `#EXTINF` and its
 * URL, and a missing final newline.
 */

const ATTR_ALIASES: Record<string, string> = {
  'tvg-id': 'tvgId',
  'channel-id': 'tvgId',
  'tvg-name': 'tvgName',
  'tvg-logo': 'logo',
  'tvg-shift': 'tvgShift',
  'tvg-chno': 'chno',
  'channel-number': 'chno',
  'group-title': 'group',
}

/** Parse `key="value"` / `key=value` pairs, respecting quotes. */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  const n = input.length
  let i = 0
  while (i < n) {
    while (i < n && (input[i] === ' ' || input[i] === '\t')) i++
    if (i >= n) break
    const keyStart = i
    while (i < n && input[i] !== '=' && input[i] !== ' ' && input[i] !== '\t') i++
    if (i >= n || input[i] !== '=') {
      // A bare token with no `=`. Skip it rather than aborting the whole line.
      if (i === keyStart) i++
      continue
    }
    const key = input.slice(keyStart, i)
    i++ // consume '='
    let value: string
    const quote = input[i]
    if (quote === '"' || quote === "'") {
      i++
      const start = i
      while (i < n && input[i] !== quote) i++
      value = input.slice(start, i)
      if (i < n) i++ // consume closing quote
    } else {
      const start = i
      while (i < n && input[i] !== ' ' && input[i] !== '\t') i++
      value = input.slice(start, i)
    }
    if (key) out[key.toLowerCase()] = value
  }
  return out
}

/** Index of the first comma that is not inside a quoted attribute value. */
function findTitleComma(s: string): number {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ',') {
      return i
    }
  }
  return -1
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** `#EXTVLCOPT:http-user-agent=X`, KODIPROP equivalents, and pipe parameters. */
function applyOption(headers: StreamHeaders, rawLine: string): void {
  const eq = rawLine.indexOf('=')
  if (eq < 0) return
  const key = rawLine.slice(0, eq).trim().toLowerCase()
  let value = rawLine.slice(eq + 1).trim()
  if (!value) return
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  const tryDecode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }

  switch (key) {
    case 'http-user-agent':
    case 'user-agent':
    case 'inputstream.adaptive.stream_headers.user-agent':
    case 'inputstream.adaptive.manifest_headers.user-agent':
      headers.userAgent = tryDecode(value)
      break
    case 'http-referrer':
    case 'http-referer':
    case 'referer':
    case 'referrer':
    case 'inputstream.adaptive.stream_headers.referer':
    case 'inputstream.adaptive.manifest_headers.referer':
      headers.referer = tryDecode(value)
      break
    case 'http-origin':
    case 'origin':
    case 'inputstream.adaptive.stream_headers.origin':
    case 'inputstream.adaptive.manifest_headers.origin':
      headers.origin = tryDecode(value)
      break
    case 'http-cookie':
    case 'cookie':
    case 'inputstream.adaptive.stream_headers.cookie':
    case 'inputstream.adaptive.manifest_headers.cookie':
      headers.cookie = tryDecode(value)
      break
    case 'http-extra-headers': {
      // e.g. Origin: https://www.jiotv.com
      const colon = value.indexOf(':')
      if (colon > 0) {
        applyOption(headers, `${value.slice(0, colon).trim()}=${value.slice(colon + 1).trim()}`)
      }
      break
    }
    default:
      if (key.endsWith('stream_headers') || key.endsWith('manifest_headers')) {
        for (const pair of value.split('&')) {
          const p = pair.indexOf('=')
          if (p > 0) applyOption(headers, `${pair.slice(0, p)}=${pair.slice(p + 1)}`)
        }
      }
  }
}

function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const last = path.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last.replace(/\.[a-z0-9]{2,5}$/i, ''))
  } catch {
    /* not an absolute URL — fall through */
  }
  return url
}

export function parseM3U(text: string): ParsedPlaylist {
  // Strip a UTF-8 BOM, which otherwise breaks the `#EXTM3U` check.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const entries: RawEntry[] = []
  const epgUrls: string[] = []
  let playlistName: string | undefined

  // State accumulated for the entry whose URL has not been seen yet.
  let pending: Partial<RawEntry> | null = null
  let pendingHeaders: StreamHeaders = {}
  let pendingDrm: RawEntry['drm'] = undefined
  let pendingGroup: string | undefined

  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]
    // Handle CRLF without a second full pass over the document.
    if (line.endsWith('\r')) line = line.slice(0, -1)
    line = line.trim()
    if (!line) continue

    if (line.charCodeAt(0) === 35 /* '#' */) {
      if (line.startsWith('#EXTINF:')) {
        const rest = line.slice(8)
        const comma = findTitleComma(rest)
        const head = comma === -1 ? rest : rest.slice(0, comma)
        const title = comma === -1 ? '' : rest.slice(comma + 1).trim()

        // Duration is the first whitespace-delimited token of the head.
        const sp = head.search(/[ \t]/)
        const durationToken = sp === -1 ? head : head.slice(0, sp)
        const attrs = parseAttributes(sp === -1 ? '' : head.slice(sp))

        const mapped: Record<string, string> = {}
        for (const [k, v] of Object.entries(attrs)) {
          mapped[ATTR_ALIASES[k] ?? k] = v
        }

        pending = {
          name: title || mapped.tvgName || '',
          duration: toNumber(durationToken) ?? -1,
          logo: mapped.logo || undefined,
          group: mapped.group || undefined,
          tvgId: mapped.tvgId || undefined,
          tvgName: mapped.tvgName || undefined,
          tvgShift: toNumber(mapped.tvgShift),
          chno: toNumber(mapped.chno),
          catchup: mapped.catchup || undefined,
          catchupDays: toNumber(mapped['catchup-days']),
          catchupSource: mapped['catchup-source'] || undefined,
        }
        pendingHeaders = {}
        pendingDrm = undefined
        // `#EXTGRP` from a previous block must not leak into this one.
        pendingGroup = undefined
      } else if (line.startsWith('#EXTGRP:')) {
        pendingGroup = line.slice(8).trim() || undefined
      } else if (line.startsWith('#EXTVLCOPT:')) {
        applyOption(pendingHeaders, line.slice(11))
      } else if (line.startsWith('#EXTHTTP:')) {
        try {
          const jsonStr = line.slice(9).trim()
          const parsed = JSON.parse(jsonStr)
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') applyOption(pendingHeaders, `${k}=${v}`)
          }
        } catch {}
      } else if (line.startsWith('#KODIPROP:')) {
        const prop = line.slice(10).trim()
        const eq = prop.indexOf('=')
        if (eq > 0) {
          const k = prop.slice(0, eq).trim().toLowerCase()
          let v = prop.slice(eq + 1).trim()
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1).trim()
          }
          if (k === 'inputstream.adaptive.license_key') {
            if (v.startsWith('{')) {
              try {
                const parsed = JSON.parse(v)
                if (parsed.keys && Array.isArray(parsed.keys)) {
                  const clearKeys: Record<string, string> = {}
                  for (const item of parsed.keys) {
                    if (item.kid && item.k) {
                      const cleanKid = String(item.kid).trim().replace(/-/g, '').toLowerCase()
                      const cleanKey = String(item.k).trim().replace(/-/g, '').toLowerCase()
                      clearKeys[cleanKid] = cleanKey
                    }
                  }
                  if (Object.keys(clearKeys).length) {
                    const firstKid = Object.keys(clearKeys)[0]
                    pendingDrm = {
                      type: 'clearkey',
                      keyId: firstKid,
                      key: clearKeys[firstKid],
                      clearKeys,
                    }
                  }
                } else if (typeof parsed === 'object') {
                  const clearKeys: Record<string, string> = {}
                  for (const [keyId, key] of Object.entries(parsed)) {
                    if (typeof key === 'string') {
                      clearKeys[keyId.trim().replace(/-/g, '').toLowerCase()] = key.trim().replace(/-/g, '').toLowerCase()
                    }
                  }
                  if (Object.keys(clearKeys).length) {
                    const firstKid = Object.keys(clearKeys)[0]
                    pendingDrm = {
                      type: 'clearkey',
                      keyId: firstKid,
                      key: clearKeys[firstKid],
                      clearKeys,
                    }
                  }
                }
              } catch {}
            } else if (v.startsWith('http://') || v.startsWith('https://')) {
              const pipe = v.indexOf('|')
              const url = pipe === -1 ? v : v.slice(0, pipe).trim()
              if (pipe !== -1) {
                const pipeParams = v.slice(pipe + 1).trim()
                for (const pair of pipeParams.split('&')) {
                  applyOption(pendingHeaders, pair)
                }
              }
              pendingDrm = {
                type: 'clearkey',
                licenseUrl: url,
              }
            } else if (v.includes(':')) {
              const [kid, key] = v.split(':')
              const cleanKid = kid.trim().replace(/-/g, '').toLowerCase()
              const cleanKey = key.trim().replace(/-/g, '').toLowerCase()
              pendingDrm = {
                type: 'clearkey',
                keyId: cleanKid,
                key: cleanKey,
                clearKeys: { [cleanKid]: cleanKey },
              }
            }
          } else if (k === 'inputstream.adaptive.license_type') {
            if (!pendingDrm) pendingDrm = { type: 'clearkey' }
          } else {
            applyOption(pendingHeaders, prop)
          }
        }
      } else if (line.startsWith('#EXTM3U')) {
        const attrs = parseAttributes(line.slice(7))
        for (const key of ['x-tvg-url', 'url-tvg', 'tvg-url']) {
          const v = attrs[key]
          if (!v) continue
          for (const u of v.split(',')) {
            const t = u.trim()
            if (t && !epgUrls.includes(t)) epgUrls.push(t)
          }
        }
      } else if (line.startsWith('#PLAYLIST:')) {
        playlistName = line.slice(10).trim() || undefined
      }
      continue
    }

    // A non-comment line is a stream URL, closing whichever entry is pending.
    let url = line
    const pipeIdx = line.indexOf('|')
    if (pipeIdx !== -1) {
      url = line.slice(0, pipeIdx).trim()
      if (url.endsWith('?')) url = url.slice(0, -1)
      const pipeParams = line.slice(pipeIdx + 1).trim()
      for (const pair of pipeParams.split('&')) {
        const p = pair.indexOf('=')
        if (p > 0) {
          applyOption(pendingHeaders, `${pair.slice(0, p)}=${pair.slice(p + 1)}`)
        }
      }
    }

    const base = pending ?? { duration: -1 }
    const headers = Object.keys(pendingHeaders).length ? pendingHeaders : undefined
    entries.push({
      name: base.name || nameFromUrl(url),
      url,
      duration: base.duration ?? -1,
      logo: base.logo,
      group: base.group ?? pendingGroup,
      tvgId: base.tvgId,
      tvgName: base.tvgName,
      tvgShift: base.tvgShift,
      chno: base.chno,
      headers,
      drm: pendingDrm,
      catchup: base.catchup,
      catchupDays: base.catchupDays,
      catchupSource: base.catchupSource,
    })
    pending = null
    pendingHeaders = {}
    pendingDrm = undefined
    pendingGroup = undefined
  }

  return { name: playlistName, entries, epgUrls }
}

/** Cheap sanity check before committing to a full parse. */
export function looksLikeM3U(text: string): boolean {
  const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart()
  return head.startsWith('#EXTM3U') || head.startsWith('#EXTINF')
}
