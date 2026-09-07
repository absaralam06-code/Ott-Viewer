'use client'
import { useEffect, useState } from 'react'
import { nowNext } from '@/lib/db'
import type { Programme } from '@/lib/types'

interface Props {
  channelId: string
  compact?: boolean
}

export default function NowNextBadge({ channelId, compact }: Props) {
  const [now, setNow] = useState<Programme | undefined>()
  const [next, setNext] = useState<Programme | undefined>()

  useEffect(() => {
    let alive = true
    nowNext(channelId).then(({ now: n, next: nx }) => {
      if (!alive) return
      setNow(n)
      setNext(nx)
    })
    return () => { alive = false }
  }, [channelId])

  if (!now && !next) return null

  if (compact) {
    return (
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {now?.title ?? ''}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {now && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span className="live-dot" />
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--color-live)', textTransform: 'uppercase', letterSpacing: 1 }}>Now</span>
          </div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{now.title}</div>
          {now.desc && (
            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {now.desc}
            </div>
          )}
          <ProgressBar start={now.start} stop={now.stop} />
        </div>
      )}
      {next && (
        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 6 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>Next</div>
          <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>{next.title}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
            {new Date(next.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}
    </div>
  )
}

function ProgressBar({ start, stop }: { start: number; stop: number }) {
  const now = Date.now()
  const pct = Math.max(0, Math.min(1, (now - start) / (stop - start)))
  const remaining = Math.max(0, Math.round((stop - now) / 60000))

  return (
    <div style={{ marginTop: 6 }}>
      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 3 }}>
        {remaining}m left
      </div>
    </div>
  )
}
