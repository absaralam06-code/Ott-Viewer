'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import ChannelCard from '@/components/ChannelCard'
import { recentlyWatched, favoriteChannels, listPlaylists, groupsFor } from '@/lib/db'
import { useAppStore } from '@/lib/store'
import type { HistoryItem, Channel, Playlist } from '@/lib/types'
import { imgProxyUrlClient } from '@/lib/img-proxy'

export default function HomePage() {
  const router = useRouter()
  const { activePlaylistId, setActivePlaylistId } = useAppStore()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [favs, setFavs] = useState<Channel[]>([])
  const [groups, setGroups] = useState<{ name: string; count: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const ps = await listPlaylists()
      setPlaylists(ps)
      if (ps.length && !activePlaylistId) setActivePlaylistId(ps[0].id)
      const [h, f] = await Promise.all([recentlyWatched(20), favoriteChannels()])
      setHistory(h)
      setFavs(f)
      if (ps.length) {
        const id = activePlaylistId ?? ps[0].id
        const gs = await groupsFor(id, 'live')
        setGroups(gs.slice(0, 16))
      }
      setLoading(false)
    }
    void load()
  }, [activePlaylistId, setActivePlaylistId])

  if (!loading && !playlists.length) {
    return (
      <AppShell>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 20,
            padding: '3rem',
            textAlign: 'center',
            minHeight: 'calc(100dvh - 56px)',
          }}
        >
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 24,
              background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 48,
              boxShadow: '0 16px 48px rgba(59,130,246,0.4)',
            }}
          >
            📺
          </div>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: '0 0 8px' }}>Welcome to OTT Player</h1>
            <p style={{ color: 'var(--color-text-muted)', margin: 0, fontSize: '1rem' }}>
              Add your first playlist to start watching.
            </p>
          </div>
          <button className="btn-primary" style={{ fontSize: '1rem', padding: '0.75rem 2rem' }} onClick={() => router.push('/settings')}>
            Add Playlist →
          </button>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, maxWidth: 600, marginTop: 24, width: '100%' }}>
            {[
              { icon: '🔗', title: 'M3U URL', desc: 'Paste any M3U/M3U8 link from your provider' },
              { icon: '🔑', title: 'Xtream Codes', desc: 'Full API with categories, posters and EPG' },
              { icon: '📁', title: 'Local File', desc: 'Upload a .m3u file from your computer' },
            ].map((f) => (
              <div key={f.title} className="glass" style={{ borderRadius: 'var(--radius-lg)', padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>{f.icon}</div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{f.title}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div style={{ padding: '1.5rem', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
        {/* Continue watching */}
        {history.length > 0 && (
          <section style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <div className="section-heading">▶ Continue Watching</div>
            </div>
            <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
              {history.map((item) => (
                <button
                  key={item.channelId}
                  onClick={() => router.push(`/watch/${encodeURIComponent(item.channelId)}`)}
                  style={{
                    flexShrink: 0,
                    width: item.kind === 'live' ? 160 : 130,
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    textAlign: 'left',
                    padding: 0,
                    transition: 'transform 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--color-border-hover)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = 'var(--color-border)' }}
                >
                  <div style={{ aspectRatio: item.kind === 'live' ? '16/9' : '2/3', background: 'var(--color-surface-2)', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {item.logo ? (
                      <img src={imgProxyUrlClient(item.logo)} alt={item.name} style={{ width: '100%', height: '100%', objectFit: item.kind === 'live' ? 'contain' : 'cover' }} />
                    ) : (
                      <span style={{ fontSize: 32 }}>{item.kind === 'movie' ? '🎬' : item.kind === 'series' ? '🎭' : '📺'}</span>
                    )}
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.8))', padding: '16px 8px 6px', fontSize: '0.72rem', color: 'white', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </div>
                    {item.position && item.duration && (
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.2)' }}>
                        <div style={{ height: '100%', width: `${Math.min(100, (item.position / item.duration) * 100)}%`, background: 'var(--color-accent)' }} />
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Favorites */}
        {favs.length > 0 && (
          <section style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <div className="section-heading">★ Favorites</div>
              <Link href="/live" style={{ fontSize: '0.82rem', color: 'var(--color-accent-hover)', textDecoration: 'none' }}>See all →</Link>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
              {favs.slice(0, 12).map((ch) => (
                <ChannelCard key={ch.id} channel={ch} onClick={() => router.push(`/watch/${encodeURIComponent(ch.id)}`)} />
              ))}
            </div>
          </section>
        )}

        {/* Groups quick-access */}
        {groups.length > 0 && (
          <section style={{ marginBottom: '2rem' }}>
            <div className="section-heading" style={{ marginBottom: '0.75rem' }}>📡 Channel Groups</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
              {groups.map((g) => (
                <Link
                  key={g.name}
                  href={`/live`}
                  onClick={() => { useAppStore.getState().setSelectedGroup(g.name); useAppStore.getState().setSelectedKind('live') }}
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '0.75rem',
                    textDecoration: 'none',
                    display: 'block',
                    transition: 'border-color 0.15s, transform 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-hover)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.transform = '' }}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 2 }}>{g.count} channels</div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Quick-nav tiles if nothing yet */}
        {history.length === 0 && favs.length === 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginTop: 24 }}>
            {[
              { href: '/live', icon: '📡', label: 'Browse Live TV', desc: 'All channels and groups' },
              { href: '/movies', icon: '🎬', label: 'Movies', desc: 'VOD library' },
              { href: '/series', icon: '🎭', label: 'Series', desc: 'TV shows and seasons' },
              { href: '/guide', icon: '📋', label: 'EPG Guide', desc: 'Timeline view' },
              { href: '/settings', icon: '⚙️', label: 'Settings', desc: 'Manage playlists & EPG' },
            ].map((t) => (
              <Link
                key={t.href}
                href={t.href}
                style={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '1.25rem',
                  textDecoration: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  transition: 'border-color 0.15s, transform 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-hover)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.transform = '' }}
              >
                <div style={{ fontSize: 32 }}>{t.icon}</div>
                <div style={{ fontWeight: 700 }}>{t.label}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{t.desc}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
