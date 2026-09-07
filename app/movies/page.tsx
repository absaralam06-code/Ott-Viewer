'use client'
import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import AppShell from '@/components/AppShell'
import PosterCard from '@/components/PosterCard'
import GroupSidebar from '@/components/GroupSidebar'
import SearchBar from '@/components/SearchBar'
import { useRouter } from 'next/navigation'
import { queryChannels, groupsFor, listPlaylists } from '@/lib/db'
import { useAppStore } from '@/lib/store'
import type { Channel } from '@/lib/types'

export default function MoviesPage() {
  const router = useRouter()
  const { activePlaylistId, setActivePlaylistId } = useAppStore()
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listPlaylists().then((ps) => {
      if (ps.length && !activePlaylistId) setActivePlaylistId(ps[0].id)
    })
  }, [activePlaylistId, setActivePlaylistId])

  useEffect(() => {
    if (!activePlaylistId) return
    groupsFor(activePlaylistId, 'movie').then(setGroups)
  }, [activePlaylistId])

  useEffect(() => {
    if (!activePlaylistId) return
    setLoading(true)
    queryChannels({
      playlistId: activePlaylistId,
      kind: 'movie',
      group: selectedGroup ?? undefined,
      search: search || undefined,
      limit: 200,
    }).then(({ rows, total: t }) => {
      setChannels(rows)
      setTotal(t)
      setLoading(false)
    })
  }, [activePlaylistId, selectedGroup, search])

  // Grid virtualiser – 5 columns
  const COLS = 5
  const rowCount = Math.ceil(channels.length / COLS)
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 240,
    overscan: 5,
  })

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.6rem 1rem', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
          <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>🎬 Movies</h1>
          <div style={{ flex: 1, maxWidth: 320 }}>
            <SearchBar value={search} onChange={setSearch} placeholder="Search movies…" />
          </div>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{total.toLocaleString()} titles</span>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Sidebar */}
          <div style={{ width: 200, flexShrink: 0, padding: '0.75rem 0.5rem 0.75rem 0.75rem', borderRight: '1px solid var(--color-border)', overflowY: 'auto' }}>
            <GroupSidebar groups={groups} selected={selectedGroup} onSelect={setSelectedGroup} />
          </div>

          {/* Poster grid */}
          <div ref={parentRef} style={{ flex: 1, overflowY: 'auto', padding: '0.75rem' }}>
            {loading && channels.length === 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 12 }}>
                {Array.from({ length: 20 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ aspectRatio: '2/3', borderRadius: 10 }} />
                ))}
              </div>
            ) : channels.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '3rem' }}>No movies found.</div>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                {rowVirtualizer.getVirtualItems().map((vr) => {
                  const rowChannels = channels.slice(vr.index * COLS, (vr.index + 1) * COLS)
                  return (
                    <div
                      key={vr.key}
                      style={{
                        position: 'absolute',
                        top: vr.start,
                        left: 0,
                        right: 0,
                        height: vr.size,
                        display: 'grid',
                        gridTemplateColumns: `repeat(${COLS}, 1fr)`,
                        gap: 12,
                        paddingBottom: 12,
                      }}
                    >
                      {rowChannels.map((ch) => (
                        <PosterCard
                          key={ch.id}
                          channel={ch}
                          onClick={() => router.push(`/watch/${encodeURIComponent(ch.id)}`)}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
