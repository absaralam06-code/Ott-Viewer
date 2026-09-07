'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import ChannelCard from '@/components/ChannelCard'
import GroupSidebar from '@/components/GroupSidebar'
import SearchBar from '@/components/SearchBar'
import NowNextBadge from '@/components/NowNextBadge'
import {
  listPlaylists,
  queryChannels,
  groupsFor,
  toggleFavorite,
  isFavorite,
  favoriteIds,
} from '@/lib/db'
import { useAppStore } from '@/lib/store'
import type { Channel, Playlist } from '@/lib/types'

const KIND_TABS = [
  { key: 'live', label: '📡 Live' },
  { key: 'movie', label: '🎬 Movies' },
  { key: 'series', label: '🎭 Series' },
] as const

export default function LivePage() {
  const router = useRouter()
  const {
    activePlaylistId, setActivePlaylistId,
    selectedKind, setSelectedKind,
    selectedGroup, setSelectedGroup,
    favoritesOnly, setFavoritesOnly,
    search, setSearch,
  } = useAppStore()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [favSet, setFavSet] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)

  const PAGE_SIZE = 100
  const parentRef = useRef<HTMLDivElement>(null)

  // Load playlists on mount
  useEffect(() => {
    listPlaylists().then((ps) => {
      setPlaylists(ps)
      if (ps.length && !activePlaylistId) setActivePlaylistId(ps[0].id)
    })
    favoriteIds().then((ids) => setFavSet(new Set(ids)))
  }, [activePlaylistId, setActivePlaylistId])

  // Load groups when kind/playlist changes
  useEffect(() => {
    if (!activePlaylistId) return
    groupsFor(activePlaylistId, selectedKind).then(setGroups)
  }, [activePlaylistId, selectedKind])

  // Load channels
  const loadChannels = useCallback(async (reset = false) => {
    if (!activePlaylistId) return
    setLoading(true)
    const offset = reset ? 0 : page * PAGE_SIZE
    const { rows, total: t } = await queryChannels({
      playlistId: activePlaylistId,
      kind: selectedKind,
      group: selectedGroup ?? undefined,
      search: search || undefined,
      favoritesOnly,
      offset,
      limit: PAGE_SIZE,
    })
    if (reset) {
      setChannels(rows)
      setPage(0)
    } else {
      setChannels((prev) => (offset === 0 ? rows : [...prev, ...rows]))
    }
    setTotal(t)
    setLoading(false)
  }, [activePlaylistId, selectedKind, selectedGroup, search, favoritesOnly, page])

  useEffect(() => {
    void loadChannels(true)
  }, [activePlaylistId, selectedKind, selectedGroup, search, favoritesOnly])

  // Virtualiser
  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 10,
  })

  const handleToggleFav = async (channelId: string) => {
    const next = await toggleFavorite(channelId)
    setFavSet((prev) => {
      const s = new Set(prev)
      next ? s.add(channelId) : s.delete(channelId)
      return s
    })
    if (favoritesOnly) void loadChannels(true)
  }

  if (!playlists.length) {
    return (
      <AppShell>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 16, padding: '3rem' }}>
          <span style={{ fontSize: 64 }}>📺</span>
          <h2 style={{ margin: 0 }}>No playlists yet</h2>
          <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>Add an M3U URL or Xtream login in Settings.</p>
          <button className="btn-primary" onClick={() => router.push('/settings')}>Go to Settings</button>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px 12px',
            padding: '0.6rem 1rem',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          {/* Playlist selector */}
          {playlists.length > 1 && (
            <select
              className="input"
              value={activePlaylistId ?? ''}
              onChange={(e) => setActivePlaylistId(e.target.value)}
              style={{ width: 'auto', maxWidth: 180 }}
            >
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          )}

          {/* Kind tabs */}
          <div className="tab-row" style={{ flexShrink: 0 }}>
            {KIND_TABS.map(({ key, label }) => (
              <button
                key={key}
                className={`tab-btn${selectedKind === key ? ' active' : ''}`}
                onClick={() => setSelectedKind(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Favorites toggle */}
          <button
            className={favoritesOnly ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setFavoritesOnly(!favoritesOnly)}
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.82rem', flexShrink: 0 }}
          >
            ★ Fav
          </button>

          <div style={{ flex: 1, maxWidth: 320 }}>
            <SearchBar value={search} onChange={(s) => { setSearch(s); }} />
          </div>

          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', flexShrink: 0 }}>
            {total.toLocaleString()} channels
          </span>
        </div>

        {/* Main split: sidebar + list */}
        <div className="live-split-container" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Group sidebar */}
          <div
            className="live-sidebar-container"
            style={{
              width: 200,
              flexShrink: 0,
              padding: '0.75rem 0.5rem 0.75rem 0.75rem',
              borderRight: '1px solid var(--color-border)',
              overflowY: 'auto',
            }}
          >
            <GroupSidebar
              groups={groups}
              selected={selectedGroup}
              onSelect={setSelectedGroup}
              loading={loading && !groups.length}
            />
          </div>

          {/* Channel list (virtualised) */}
          <div
            ref={parentRef}
            style={{ flex: 1, overflowY: 'auto', padding: '0.75rem' }}
            onScroll={(e) => {
              const el = e.currentTarget
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && !loading && channels.length < total) {
                setPage((p) => p + 1)
              }
            }}
          >
            {channels.length === 0 && !loading ? (
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '3rem' }}>
                {search ? 'No results for that search.' : 'No channels in this group.'}
              </div>
            ) : (
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
                        height: vr.size,
                        paddingBottom: 6,
                      }}
                    >
                      <ChannelCard
                        channel={ch}
                        isFavorite={favSet.has(ch.id)}
                        nowTitle={ch.tvgId ? undefined : undefined}
                        onToggleFavorite={() => void handleToggleFav(ch.id)}
                        onClick={() => router.push(`/watch/${encodeURIComponent(ch.id)}`)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
                <span className="spinner" />
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
