'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import AppShell from '@/components/AppShell'
import { programmesForMany, listPlaylists, queryChannels } from '@/lib/db'
import { useAppStore } from '@/lib/store'
import { imgProxyUrlClient } from '@/lib/img-proxy'
import type { Channel, Programme } from '@/lib/types'
import { useRouter } from 'next/navigation'

const PX_PER_MIN = 4
const CHANNEL_COL_W = 160
const ROW_H = 56
const HEADER_H = 40
const WINDOW_HOURS = 3

function fmt(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function GuidePage() {
  const router = useRouter()
  const { activePlaylistId, setActivePlaylistId } = useAppStore()

  const [channels, setChannels] = useState<Channel[]>([])
  const [epgMap, setEpgMap] = useState<Map<string, Programme[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [viewStart, setViewStart] = useState(() => {
    const now = Date.now()
    // Start 1 hour before now, snapped to 30min
    return Math.floor((now - 60 * 60 * 1000) / (30 * 60 * 1000)) * (30 * 60 * 1000)
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const timeAxisRef = useRef<HTMLDivElement>(null)

  const viewEnd = viewStart + WINDOW_HOURS * 60 * 60 * 1000

  useEffect(() => {
    listPlaylists().then((ps) => {
      if (ps.length && !activePlaylistId) setActivePlaylistId(ps[0].id)
    })
  }, [activePlaylistId, setActivePlaylistId])

  useEffect(() => {
    if (!activePlaylistId) return
    setLoading(true)
    queryChannels({ playlistId: activePlaylistId, kind: 'live', limit: 100 }).then(async ({ rows }) => {
      setChannels(rows)
      const ids = rows.map((c) => c.id)
      const map = await programmesForMany(ids, viewStart, viewEnd)
      setEpgMap(map)
      setLoading(false)
    })
  }, [activePlaylistId, viewStart])

  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  })

  // Now marker position
  const now = Date.now()
  const nowOffset = Math.max(0, ((now - viewStart) / 60000) * PX_PER_MIN)

  // Time axis ticks every 30 min
  const tickCount = WINDOW_HOURS * 2
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    ms: viewStart + i * 30 * 60 * 1000,
    x: i * 30 * PX_PER_MIN,
  }))

  const totalWidth = WINDOW_HOURS * 60 * PX_PER_MIN

  const syncScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (timeAxisRef.current) timeAxisRef.current.scrollLeft = e.currentTarget.scrollLeft
  }

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.6rem 1rem', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
          <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>📋 Guide</h1>
          <button className="btn-ghost" onClick={() => setViewStart((v) => v - 60 * 60 * 1000)} style={{ padding: '0.3rem 0.75rem' }}>← 1h</button>
          <button className="btn-ghost" onClick={() => setViewStart(Math.floor((Date.now() - 60 * 60 * 1000) / (30 * 60000)) * 30 * 60000)} style={{ padding: '0.3rem 0.75rem' }}>Now</button>
          <button className="btn-ghost" onClick={() => setViewStart((v) => v + 60 * 60 * 1000)} style={{ padding: '0.3rem 0.75rem' }}>+1h →</button>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
            {fmt(viewStart)} – {fmt(viewEnd)}
          </span>
        </div>

        {/* Guide grid */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left column header spacer */}
          <div style={{ width: CHANNEL_COL_W, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Spacer for time header */}
            <div style={{ height: HEADER_H, borderBottom: '1px solid var(--color-border)', borderRight: '1px solid var(--color-border)', background: 'var(--color-surface)' }} />
            {/* Channel names (synced scroll via virtualiser) */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div ref={scrollRef as unknown as React.RefObject<HTMLDivElement>} style={{ height: '100%', overflow: 'hidden', position: 'relative' }}>
                <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                  {rowVirtualizer.getVirtualItems().map((vr) => {
                    const ch = channels[vr.index]
                    if (!ch) return null
                    return (
                      <div
                        key={ch.id}
                        style={{
                          position: 'absolute',
                          top: vr.start,
                          left: 0,
                          right: 0,
                          height: ROW_H,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '0 8px',
                          borderBottom: '1px solid var(--color-border)',
                          borderRight: '1px solid var(--color-border)',
                          background: 'var(--color-surface)',
                          cursor: 'pointer',
                        }}
                        onClick={() => router.push(`/watch/${encodeURIComponent(ch.id)}`)}
                      >
                        {ch.logo && (
                          <img src={imgProxyUrlClient(ch.logo)} alt="" style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4 }} />
                        )}
                        <span style={{ fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                          {ch.name}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Timeline area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Time axis */}
            <div
              ref={timeAxisRef}
              style={{ height: HEADER_H, overflow: 'hidden', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', position: 'relative' }}
            >
              <div style={{ width: totalWidth, height: '100%', position: 'relative', flexShrink: 0 }}>
                {ticks.map((t) => (
                  <div
                    key={t.ms}
                    style={{ position: 'absolute', left: t.x, top: 0, height: '100%', borderLeft: '1px solid var(--color-border)', paddingLeft: 6, display: 'flex', alignItems: 'center' }}
                  >
                    <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>{fmt(t.ms)}</span>
                  </div>
                ))}
                {/* Now marker on axis */}
                <div style={{ position: 'absolute', left: nowOffset, top: 0, bottom: 0, borderLeft: '2px solid var(--color-accent)', zIndex: 3 }} />
              </div>
            </div>

            {/* Programme rows */}
            <div
              style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', position: 'relative' }}
              onScroll={(e) => {
                if (timeAxisRef.current) timeAxisRef.current.scrollLeft = e.currentTarget.scrollLeft
                if (scrollRef.current) scrollRef.current.scrollTop = e.currentTarget.scrollTop
              }}
            >
              <div style={{ width: totalWidth, height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                {/* Now line */}
                <div style={{ position: 'absolute', left: nowOffset, top: 0, bottom: 0, borderLeft: '2px solid var(--color-accent)', zIndex: 4, opacity: 0.8 }} />

                {rowVirtualizer.getVirtualItems().map((vr) => {
                  const ch = channels[vr.index]
                  if (!ch) return null
                  const progs = epgMap.get(ch.id) ?? []
                  return (
                    <div
                      key={ch.id}
                      style={{ position: 'absolute', top: vr.start, left: 0, right: 0, height: ROW_H, borderBottom: '1px solid var(--color-border)' }}
                    >
                      {progs.map((p) => {
                        const left = Math.max(0, ((p.start - viewStart) / 60000) * PX_PER_MIN)
                        const right = Math.min(totalWidth, ((p.stop - viewStart) / 60000) * PX_PER_MIN)
                        const width = right - left
                        if (width < 2) return null
                        const isCurrent = p.start <= now && p.stop > now
                        return (
                          <div
                            key={`${p.channelId}-${p.start}`}
                            style={{
                              position: 'absolute',
                              left,
                              width: width - 2,
                              top: 4,
                              height: ROW_H - 8,
                              background: isCurrent ? 'rgba(59,130,246,0.25)' : 'var(--color-surface-2)',
                              border: `1px solid ${isCurrent ? 'rgba(59,130,246,0.5)' : 'var(--color-border)'}`,
                              borderRadius: 6,
                              overflow: 'hidden',
                              padding: '2px 6px',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'center',
                              cursor: 'pointer',
                            }}
                            title={`${p.title}\n${fmt(p.start)} – ${fmt(p.stop)}`}
                            onClick={() => router.push(`/watch/${encodeURIComponent(ch.id)}`)}
                          >
                            <div style={{ fontSize: '0.75rem', fontWeight: isCurrent ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: isCurrent ? 'var(--color-accent-hover)' : 'var(--color-text)' }}>
                              {p.title}
                            </div>
                            {width > 80 && (
                              <div style={{ fontSize: '0.66rem', color: 'var(--color-text-muted)', marginTop: 1 }}>
                                {fmt(p.start)}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {loading && (
          <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '6px 12px', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
            <span className="spinner" style={{ width: 14, height: 14 }} />
            Loading guide…
          </div>
        )}
      </div>
    </AppShell>
  )
}
