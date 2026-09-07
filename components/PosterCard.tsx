'use client'
import { imgProxyUrlClient } from '@/lib/img-proxy'
import type { Channel } from '@/lib/types'

interface Props {
  channel: Channel
  onClick?: () => void
}

export default function PosterCard({ channel, onClick }: Props) {
  const posterUrl = imgProxyUrlClient(channel.poster ?? channel.logo)

  return (
    <button
      onClick={onClick}
      className="poster-card"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        padding: 0,
      }}
    >
      {/* Poster image */}
      <div
        style={{
          aspectRatio: '2/3',
          background: 'var(--color-surface-2)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {posterUrl ? (
          <img
            src={posterUrl}
            alt={channel.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            loading="lazy"
            onError={(e) => {
              const el = e.currentTarget
              el.style.display = 'none'
              const parent = el.parentElement
              if (parent) {
                parent.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2rem">${channel.kind === 'series' ? '🎭' : '🎬'}</div>`
              }
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2.5rem',
            }}
          >
            {channel.kind === 'series' ? '🎭' : '🎬'}
          </div>
        )}

        {/* Year chip */}
        {channel.year && (
          <span
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              background: 'rgba(0,0,0,0.7)',
              color: 'var(--color-text-dim)',
              fontSize: '0.7rem',
              padding: '2px 6px',
              borderRadius: 99,
              backdropFilter: 'blur(4px)',
            }}
          >
            {channel.year}
          </span>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '0.55rem 0.65rem' }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: '0.8rem',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--color-text)',
          }}
        >
          {channel.show ?? channel.name}
        </div>
        {channel.genre && (
          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {channel.genre}
          </div>
        )}
      </div>
    </button>
  )
}
