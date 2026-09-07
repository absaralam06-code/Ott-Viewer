import { NextResponse } from 'next/server'
import { hostPolicy } from '@/lib/env'
import { ProxyError, fetchUpstream, redactUrl } from '@/lib/proxy'
import { XmltvParser } from '@/lib/xmltv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * EPG import, streamed as NDJSON.
 *
 * XMLTV guides are commonly 50–300 MB uncompressed, so neither side ever holds the
 * whole thing: the file is parsed as it arrives and each surviving programme is written
 * out as its own line, letting the browser insert into IndexedDB in batches and show
 * progress. A plain JSON response would mean building a ~60 MB string in memory first.
 */

const DEFAULT_PAST_MS = 6 * 60 * 60 * 1000
const DEFAULT_FUTURE_MS = 48 * 60 * 60 * 1000

interface Body {
  url?: string
  /** tvg-ids present in the playlist. Anything else in the guide is dropped. */
  channelIds?: string[]
  from?: number
  to?: number
}

/**
 * XMLTV is usually published as `.xml.gz`. When the server labels it
 * `content-encoding: gzip` fetch decompresses it for us, but a `.gz` file served as
 * `application/gzip` arrives still compressed — so sniff the magic bytes instead of
 * trusting headers.
 */
async function decompressIfNeeded(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader()
  const first = await reader.read()
  const head = first.value
  const isGzip = !!head && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b

  const rejoined = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head && head.length) controller.enqueue(head)
      if (first.done) controller.close()
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else if (value) controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return isGzip ? rejoined.pipeThrough(new DecompressionStream('gzip') as any) : rejoined
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const url = body.url?.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: 'Enter an XMLTV URL starting with http:// or https://' },
      { status: 400 },
    )
  }

  const now = Date.now()
  const from = typeof body.from === 'number' ? body.from : now - DEFAULT_PAST_MS
  const to = typeof body.to === 'number' ? body.to : now + DEFAULT_FUTURE_MS
  const channelIds = Array.isArray(body.channelIds) ? new Set(body.channelIds.filter(Boolean)) : undefined

  let source: ReadableStream<Uint8Array>
  try {
    const { response } = await fetchUpstream({
      target: { url },
      policy: hostPolicy(),
      signal: request.signal,
    })
    if (!response.ok || !response.body) {
      return NextResponse.json(
        { error: `The EPG server returned ${response.status}.` },
        { status: 502 },
      )
    }
    source = await decompressIfNeeded(response.body)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return new Response(null, { status: 499 })
    const status = err instanceof ProxyError ? err.status : 502
    const message = err instanceof ProxyError ? err.message : 'could not fetch that EPG'
    console.error(`[epg] ${message} for ${redactUrl(url)}`)
    return NextResponse.json({ error: message }, { status })
  }

  const encoder = new TextEncoder()
  const ndjson = new ReadableStream<Uint8Array>({
    async start(controller) {
      let pending: string[] = []
      const emit = (line: unknown): void => {
        pending.push(JSON.stringify(line))
      }
      const parser = new XmltvParser({
        channelIds,
        from,
        to,
        onChannel: (c) => emit({ t: 'c', id: c.id, name: c.displayName, icon: c.icon }),
        onProgramme: (p) => emit({ t: 'p', ...p }),
      })

      const flush = async (): Promise<void> => {
        if (pending.length) {
          controller.enqueue(encoder.encode(pending.join('\n') + '\n'))
          pending = []
        }
        // Respect backpressure: without this a fast guide and a slow client would
        // queue the entire file in this process's memory.
        while (controller.desiredSize !== null && controller.desiredSize <= 0) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }

      const decoder = new TextDecoder('utf-8')
      const reader = source.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) parser.write(decoder.decode(value, { stream: true }))
          await flush()
        }
        parser.write(decoder.decode())
        parser.end()
        emit({ t: 'end', count: parser.count, skipped: parser.skipped })
        await flush()
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError'
        if (!aborted) {
          console.error(`[epg] parse failed for ${redactUrl(url)}`)
          emit({ t: 'error', message: 'The EPG download failed part-way through.' })
          await flush().catch(() => {})
        }
      } finally {
        await reader.cancel().catch(() => {})
        controller.close()
      }
    },
  })

  return new Response(ndjson, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
