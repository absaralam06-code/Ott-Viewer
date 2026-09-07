'use client'
import { imgProxyUrlClient } from '@/lib/img-proxy'
import type { Channel } from '@/lib/types'

interface Props {
  channel: Channel
  active?: boolean
  nowTitle?: string
  progress?: number // 0-1
  isFavorite?: boolean
  onToggleFavorite?: () => void
  onClick?: () => void
}

export default function ChannelCard({
  channel,
  active,
  nowTitle,
  progress,
  isFavorite,
  onToggleFavorite,
  onClick,
}: Props) {
  const logoUrl = imgProxyUrlClient(channel.logo)

  return (
    <button
      id={`ch-${channel.id}`}
      onClick={onClick}
      className={`channel-card${active ? ' active' : ''}`}
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: '0.65rem 0.75rem',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '0.65rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Logo */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          background: 'var(--color-surface-2)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={channel.name}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <span style={{ fontSize: 20 }}>{channel.kind === 'movie' ? '🎬' : channel.kind === 'series' ? '🎭' : '📺'}</span>
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: '0.875rem',
            color: active ? 'var(--color-accent-hover)' : 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {channel.name}
        </div>
        {nowTitle && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--color-text-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 2,
            }}
          >
            {nowTitle}
          </div>
        )}
        {typeof progress === 'number' && progress > 0 && (
          <div className="progress-bar" style={{ marginTop: 4 }}>
            <div className="progress-bar-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        )}
      </div>

      {/* Live badge */}
      {channel.kind === 'live' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span className="live-dot" />
        </div>
      )}

      {/* Favorite */}
      {onToggleFavorite && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              onToggleFavorite()
            }
          }}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 4px',
            fontSize: 16,
            color: isFavorite ? 'var(--color-fav)' : 'var(--color-text-muted)',
            transition: 'color 0.15s',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isFavorite ? '★' : '☆'}
        </span>
      )}

      {/* Active glow line */}
      {active && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: 'var(--color-accent)',
            borderRadius: '99px 0 0 99px',
          }}
        />
      )}
    </button>
  )
}
