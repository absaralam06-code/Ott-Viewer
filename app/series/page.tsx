'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import PosterCard from '@/components/PosterCard'
import SearchBar from '@/components/SearchBar'
import { listShows, episodesOf, listPlaylists } from '@/lib/db'
import { useAppStore } from '@/lib/store'
import type { Channel } from '@/lib/types'
import { imgProxyUrlClient } from '@/lib/img-proxy'

export default function SeriesPage() {
  const router = useRouter()
  const { activePlaylistId, setActivePlaylistId } = useAppStore()
  const [shows, setShows] = useState<Channel[]>([])
  const [filtered, setFiltered] = useState<Channel[]>([])
  const [search, setSearch] = useState('')
  const [selectedShow, setSelectedShow] = useState<Channel | null>(null)
  const [episodes, setEpisodes] = useState<Channel[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    listPlaylists().then((ps) => {
      if (ps.length && !activePlaylistId) setActivePlaylistId(ps[0].id)
    })
  }, [activePlaylistId, setActivePlaylistId])

  useEffect(() => {
    if (!activePlaylistId) return
    setLoading(true)
    listShows(activePlaylistId).then((s) => {
      setShows(s)
      setFiltered(s)
      setLoading(false)
    })
  }, [activePlaylistId])

  useEffect(() => {
    if (!search) { setFiltered(shows); return }
    const lower = search.toLowerCase()
    setFiltered(shows.filter((s) => (s.show ?? s.name).toLowerCase().includes(lower)))
  }, [search, shows])

  useEffect(() => {
    if (!selectedShow || !activePlaylistId) return
    episodesOf(activePlaylistId, selectedShow.show ?? selectedShow.name).then(setEpisodes)
  }, [selectedShow, activePlaylistId])

  const COLS = 5

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.6rem 1rem', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
          {selectedShow ? (
            <>
              <button onClick={() => { setSelectedShow(null); setEpisodes([]) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text)', fontSize: 18 }}>←</button>
              <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>{selectedShow.show ?? selectedShow.name}</h1>
            </>
          ) : (
            <>
              <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>🎭 Series</h1>
              <div style={{ flex: 1, maxWidth: 320 }}>
                <SearchBar value={search} onChange={setSearch} placeholder="Search series…" />
              </div>
              <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{filtered.length.toLocaleString()} shows</span>
            </>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem' }}>
          {/* Show grid */}
          {!selectedShow && (
            loading ? (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 12 }}>
                {Array.from({ length: 20 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ aspectRatio: '2/3', borderRadius: 10 }} />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '3rem' }}>No series found.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: 12 }}>
                {filtered.map((ch) => (
                  <PosterCard key={ch.id} channel={ch} onClick={() => setSelectedShow(ch)} />
                ))}
              </div>
            )
          )}

          {/* Episode list */}
          {selectedShow && (
            <div>
              {/* Show hero */}
              <div style={{ display: 'flex', gap: 24, marginBottom: 24 }}>
                {(selectedShow.poster ?? selectedShow.logo) && (
                  <img
                    src={imgProxyUrlClient(selectedShow.poster ?? selectedShow.logo)}
                    alt={selectedShow.show ?? selectedShow.name}
                    style={{ width: 140, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
                  />
                )}
                <div>
                  <h2 style={{ margin: '0 0 8px', fontSize: '1.4rem' }}>{selectedShow.show ?? selectedShow.name}</h2>
                  {selectedShow.plot && <p style={{ margin: 0, color: 'var(--color-text-dim)', fontSize: '0.875rem', lineHeight: 1.6 }}>{selectedShow.plot}</p>}
                  {selectedShow.genre && <div className="chip" style={{ marginTop: 8 }}>{selectedShow.genre}</div>}
                </div>
              </div>

              {/* Episodes grouped by season */}
              {Object.entries(
                episodes.reduce<Record<number, Channel[]>>((acc, ep) => {
                  const s = ep.season ?? 1
                  acc[s] = acc[s] ?? []
                  acc[s].push(ep)
                  return acc
                }, {})
              ).map(([season, eps]) => (
                <div key={season} style={{ marginBottom: 24 }}>
                  <div className="section-heading" style={{ marginBottom: 12 }}>Season {season}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {eps.map((ep) => (
                      <button
                        key={ep.id}
                        onClick={() => router.push(`/watch/${encodeURIComponent(ep.id)}`)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '0.65rem 0.75rem',
                          background: 'var(--color-surface)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          transition: 'border-color 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-border-hover)')}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
                      >
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--color-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700, color: 'var(--color-text-muted)', flexShrink: 0 }}>
                          E{ep.episode ?? '?'}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ep.name}</div>
                        </div>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: 18 }}>▶</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
