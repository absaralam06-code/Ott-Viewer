'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import AppShell from '@/components/AppShell'
import NowNextBadge from '@/components/NowNextBadge'
import ChannelCard from '@/components/ChannelCard'
import {
  getChannel,
  queryChannels,
  recordWatch,
  watchProgress,
  toggleFavorite,
  isFavorite,
} from '@/lib/db'
import { signStreamUrl } from '@/lib/img-proxy'
import type { Channel } from '@/lib/types'
import { useAppStore } from '@/lib/store'

// Player is browser-only — dynamic import with ssr:false
const Player = dynamic(() => import('@/components/Player'), { ssr: false })

export default function WatchPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { activePlaylistId } = useAppStore()

  const [channel, setChannel] = useState<Channel | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [ticket, setTicket] = useState<{ t: string; ts: string } | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [adjacent, setAdjacent] = useState<Channel[]>([])
  const [favored, setFavored] = useState(false)
  const [initialPos, setInitialPos] = useState(0)
  const posRef = useRef(0)

  const channelId = decodeURIComponent(id)

  const loadChannel = useCallback(async (cid: string) => {
    setLoading(true)
    setError(null)
    setSrc(null)
    setTicket(undefined)

    const ch = await getChannel(cid)
    if (!ch) {
      setError('Channel not found.')
      setLoading(false)
      return
    }

    // Backwards-compatibility for existing IndexedDB entries with Hotstar ClearKey license
    let normalizedCh = ch
    if (
      (!ch.drm?.licenseUrl && ch.drm?.keyId === 'https') ||
      (!ch.drm?.licenseUrl && ch.url.includes('hotstar'))
    ) {
      normalizedCh = {
        ...ch,
        drm: {
          type: 'clearkey',
          licenseUrl: 'https://hotstarlicenceurl.cstds.workers.dev/plugx',
        },
      }
    }

    setChannel(normalizedCh)
    setFavored(await isFavorite(cid))

    // Restore VOD progress
    if (ch.kind !== 'live') {
      const prog = await watchProgress(cid)
      if (prog?.position) setInitialPos(prog.position)
    }

    // Sign the stream URL through the proxy
    try {
      const signed = await signStreamUrl(ch.url, ch.headers)
      setSrc(signed.src)
      setTicket(signed.ticket)
    } catch {
      setError('Could not prepare stream. Try again.')
    }
    setLoading(false)
  }, [])

  // Load adjacent channels for zapping
  const loadAdjacent = useCallback(async (ch: Channel) => {
    const pid = ch.playlistId
    const { rows } = await queryChannels({ playlistId: pid, kind: ch.kind, limit: 200 })
    setAdjacent(rows)
  }, [])

  useEffect(() => {
    void loadChannel(channelId)
  }, [channelId, loadChannel])

  useEffect(() => {
    if (channel) void loadAdjacent(channel)
  }, [channel, loadAdjacent])

  // Record history
  useEffect(() => {
    if (!channel) return
    void recordWatch({
      channelId: channel.id,
      playlistId: channel.playlistId,
      name: channel.name,
      logo: channel.logo,
      kind: channel.kind,
      watchedAt: Date.now(),
    })
  }, [channel])

  // Zapping
  const currentIdx = adjacent.findIndex((c) => c.id === channelId)
  const zapTo = (offset: number) => {
    const next = adjacent[currentIdx + offset]
    if (next) router.replace(`/watch/${encodeURIComponent(next.id)}`)
  }

  const handleToggleFav = async () => {
    if (!channel) return
    const next = await toggleFavorite(channel.id)
    setFavored(next)
  }

  const handlePositionChange = (pos: number) => {
    posRef.current = pos
    if (channel?.kind !== 'live') {
      void recordWatch({
        channelId: channel!.id,
        playlistId: channel!.playlistId,
        name: channel!.name,
        logo: channel!.logo,
        kind: channel!.kind,
        watchedAt: Date.now(),
        position: pos,
        duration: channel!.duration > 0 ? channel!.duration : undefined,
      })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: '#000' }}>
      {/* Top bar */}
      <div
        className="watch-topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0.5rem 1rem',
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(8px)',
          zIndex: 30,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'white', fontSize: 20, padding: '4px 8px' }}
          aria-label="Back"
        >
          ←
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {channel?.name ?? 'Loading…'}
          </div>
          {channel?.group && (
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>{channel.group}</div>
          )}
        </div>
        {channel && (
          <button
            onClick={() => void handleToggleFav()}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: favored ? 'var(--color-fav)' : 'rgba(255,255,255,0.5)', fontSize: 22 }}
            aria-label={favored ? 'Remove from favorites' : 'Add to favorites'}
          >
            {favored ? '★' : '☆'}
          </button>
        )}
      </div>

      {/* Player + sidebar */}
      <div className="watch-layout" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Player */}
        <div className="watch-player-pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {loading && !src && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="spinner" style={{ width: 48, height: 48, borderWidth: 3 }} />
            </div>
          )}
          {error && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', gap: 12, padding: '1rem', textAlign: 'center' }}>
              <span style={{ fontSize: 48 }}>⚠️</span>
              <p style={{ margin: 0, maxWidth: 360, fontSize: '0.9rem' }}>{error}</p>
              <button className="btn-primary" onClick={() => void loadChannel(channelId)}>Retry</button>
            </div>
          )}
          {src && channel && (
            <Player
              src={src}
              title={channel.name}
              kind={channel.kind}
              poster={channel.poster}
              drm={channel.drm}
              ticket={ticket}
              headers={channel.headers}
              initialPosition={initialPos}
              onPositionChange={handlePositionChange}
              onZapUp={() => zapTo(-1)}
              onZapDown={() => zapTo(1)}
            />
          )}

          {/* Now/Next panel */}
          {channel?.tvgId && (
            <div
              className="desktop-only"
              style={{
                background: 'rgba(0,0,0,0.9)',
                padding: '1rem',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                flexShrink: 0,
              }}
            >
              <NowNextBadge channelId={channel.id} />
            </div>
          )}
        </div>

        {/* Zap sidebar */}
        <div
          className="watch-sidebar-pane"
          style={{
            width: 280,
            flexShrink: 0,
            background: 'rgba(10,14,26,0.95)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '0.5rem',
          }}
        >
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 1, padding: '0.25rem 0.25rem 0.5rem' }}>
            {channel?.kind === 'live' ? 'Channels' : 'Episodes'}
          </div>
          {adjacent.map((ch) => (
            <ChannelCard
              key={ch.id}
              channel={ch}
              active={ch.id === channelId}
              onClick={() => router.replace(`/watch/${encodeURIComponent(ch.id)}`)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
