'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { pickEngine, attachHlsJs, attachMpegts, attachShaka } from '@/lib/player-engine'
import type { EngineHandle } from '@/lib/player-engine'
import type { DrmConfig, StreamHeaders } from '@/lib/types'
import { useAppStore } from '@/lib/store'

export interface PlayerProps {
  src: string
  title?: string
  kind?: 'live' | 'movie' | 'series'
  poster?: string
  drm?: DrmConfig
  ticket?: { t: string; ts: string }
  headers?: StreamHeaders
  onEnded?: () => void
  onZapUp?: () => void
  onZapDown?: () => void
  initialPosition?: number
  onPositionChange?: (pos: number) => void
}

export default function Player({
  src,
  title,
  kind = 'live',
  poster,
  drm,
  ticket,
  headers: streamHeaders,
  onEnded,
  onZapUp,
  onZapDown,
  initialPosition = 0,
  onPositionChange,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const engineRef = useRef<EngineHandle | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { volume, setVolume, muted, setMuted } = useAppStore()

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pip, setPip] = useState(false)
  const [stats, setStats] = useState<{ bitrate: number; buffered: number; dropped: number } | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [, setSubTracks] = useState<{ id: number; name: string }[]>([])
  const [retryTrigger, setRetryTrigger] = useState(0)

  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShowControls(false), 3500)
  }, [])

  // Mount / src change
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    setError(null)
    setLoading(true)

    engineRef.current?.destroy()
    engineRef.current = null

    const engine = pickEngine(src, video, drm)

    video.volume = volume
    video.muted = muted

    if (initialPosition > 0 && kind !== 'live') {
      video.currentTime = initialPosition
    }

    let mounted = true

    const setup = async () => {
      if (engine === 'native-hls' || engine === 'native') {
        video.src = src
        if (poster) video.poster = poster
        video.load()
      } else if (engine === 'shaka') {
        const handle = await attachShaka(src, video, {
          drm,
          ticket,
          headers: streamHeaders,
          cbs: {
            onError: (msg) => { if (mounted) setError(msg) },
            onStats: (s) => { if (mounted) setStats(s) },
          },
        })
        if (!mounted) { handle.destroy(); return }
        engineRef.current = handle
      } else if (engine === 'hlsjs') {
        const handle = await attachHlsJs(src, video, {
          onError: (msg) => { if (mounted) setError(msg) },
          onStats: (s) => { if (mounted) setStats(s) },
        })
        if (!mounted) { handle.destroy(); return }
        engineRef.current = handle
      } else {
        const handle = await attachMpegts(src, video, {
          onError: (msg) => { if (mounted) setError(msg) },
        })
        if (!mounted) { handle.destroy(); return }
        engineRef.current = handle
      }

      void video.play().catch(() => {})
    }

    void setup()

    return () => {
      mounted = false
      engineRef.current?.destroy()
      engineRef.current = null
      video.src = ''
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, retryTrigger])

  // Sync volume/muted
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [volume, muted])

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onWaiting = () => setLoading(true)
    const onCanPlay = () => setLoading(false)
    const onDurationChange = () => setDuration(video.duration || 0)
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime)
      onPositionChange?.(video.currentTime)
      if (video.buffered.length) {
        setBuffered(video.buffered.end(video.buffered.length - 1))
      }
    }
    const onError = () => setError('Playback failed. The stream may be offline.')
    const onEnterPip = () => setPip(true)
    const onLeavePip = () => setPip(false)

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('playing', onCanPlay)
    video.addEventListener('durationchange', onDurationChange)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('error', onError)
    video.addEventListener('enterpictureinpicture', onEnterPip)
    video.addEventListener('leavepictureinpicture', onLeavePip)
    video.addEventListener('ended', () => onEnded?.())

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('playing', onCanPlay)
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('error', onError)
      video.removeEventListener('enterpictureinpicture', onEnterPip)
      video.removeEventListener('leavepictureinpicture', onLeavePip)
    }
  }, [onEnded, onPositionChange])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      const video = videoRef.current
      if (!video) return

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          playing ? video.pause() : void video.play()
          break
        case 'ArrowRight':
          if (kind !== 'live') video.currentTime += 10
          break
        case 'ArrowLeft':
          if (kind !== 'live') video.currentTime -= 10
          break
        case 'ArrowUp':
          e.preventDefault()
          onZapUp?.()
          break
        case 'ArrowDown':
          e.preventDefault()
          onZapDown?.()
          break
        case 'f':
        case 'F':
          void containerRef.current?.requestFullscreen()
          break
        case 'm':
        case 'M':
          setMuted(!muted)
          break
        case 'i':
        case 'I':
          setShowStats((s) => !s)
          break
        case 'Escape':
          if (document.fullscreenElement) void document.exitFullscreen()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [playing, muted, kind, onZapUp, onZapDown, setMuted])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    playing ? v.pause() : void v.play()
  }

  const seek = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void containerRef.current?.requestFullscreen()
  }

  const togglePip = async () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else if (v.readyState >= 1) {
        await v.requestPictureInPicture()
      }
    } catch {
      /* ignore PiP errors if video metadata is not ready yet */
    }
  }

  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return '–:––'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`
  }

  const controlsAlpha = showControls || !playing ? 1 : 0

  return (
    <div
      ref={containerRef}
      onMouseMove={resetHideTimer}
      onMouseEnter={resetHideTimer}
      onTouchStart={resetHideTimer}
      style={{
        position: 'relative',
        width: '100%',
        background: '#000',
        aspectRatio: kind === 'live' ? undefined : '16/9',
        flex: kind === 'live' ? 1 : undefined,
        cursor: showControls ? 'default' : 'none',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <video
        ref={videoRef}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
        playsInline
        onClick={togglePlay}
      />

      {/* Loading spinner */}
      {loading && !error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.4)',
          }}
        >
          <span className="spinner" style={{ width: 40, height: 40, borderWidth: 3 }} />
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.75)',
            color: 'var(--color-text)',
            gap: 12,
            padding: '1rem',
            textAlign: 'center',
          }}
        >
          <span style={{ fontSize: 40 }}>⚠️</span>
          <p style={{ margin: 0, fontWeight: 600 }}>{error}</p>
          <button
            className="btn-primary"
            onClick={() => {
              setError(null)
              setLoading(true)
              setRetryTrigger((n) => n + 1)
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Stats overlay */}
      {showStats && stats && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'rgba(0,0,0,0.8)',
            color: '#4ade80',
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            padding: '8px 12px',
            borderRadius: 8,
            lineHeight: 1.7,
          }}
        >
          <div>Bitrate: {Math.round(stats.bitrate / 1000)} kbps</div>
          <div>Buffer: {stats.buffered.toFixed(1)}s</div>
          <div>Dropped: {stats.dropped} frames</div>
        </div>
      )}

      {/* Controls overlay */}
      <div
        className="player-overlay"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          opacity: controlsAlpha,
          transition: 'opacity 0.3s ease',
          background: controlsAlpha
            ? 'linear-gradient(transparent 40%, rgba(0,0,0,0.85) 100%)'
            : 'transparent',
          pointerEvents: controlsAlpha ? 'auto' : 'none',
        }}
      >
        {/* Title */}
        {title && (
          <div style={{ padding: '0 16px 4px', fontSize: '0.95rem', fontWeight: 600, textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
            {title}
          </div>
        )}

        {/* Seek bar (VOD only) */}
        {kind !== 'live' && duration > 0 && (
          <div style={{ padding: '0 16px 8px' }}>
            <div
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                seek(((e.clientX - rect.left) / rect.width) * duration)
              }}
              style={{ height: 4, background: 'rgba(255,255,255,0.25)', borderRadius: 99, cursor: 'pointer', position: 'relative' }}
            >
              {/* Buffered */}
              <div style={{ position: 'absolute', inset: 0, width: `${(buffered / duration) * 100}%`, background: 'rgba(255,255,255,0.25)', borderRadius: 99 }} />
              {/* Played */}
              <div style={{ position: 'absolute', inset: 0, width: `${(currentTime / duration) * 100}%`, background: 'var(--color-accent)', borderRadius: 99 }} />
              {/* Thumb */}
              <div style={{ position: 'absolute', top: '50%', left: `${(currentTime / duration) * 100}%`, transform: 'translate(-50%, -50%)', width: 12, height: 12, background: 'white', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.72rem', color: 'rgba(255,255,255,0.7)' }}>
              <span>{fmt(currentTime)}</span>
              <span>{fmt(duration)}</span>
            </div>
          </div>
        )}

        {/* Bottom controls row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 8px 12px',
          }}
        >
          {/* Play/pause */}
          <IBtn onClick={togglePlay} aria="Play/Pause" title={playing ? 'Pause' : 'Play'}>
            {playing ? '⏸' : '▶'}
          </IBtn>

          {/* Zap */}
          {onZapUp && <IBtn onClick={onZapUp} aria="Previous channel" title="▲">▲</IBtn>}
          {onZapDown && <IBtn onClick={onZapDown} aria="Next channel" title="▼">▼</IBtn>}

          {/* Volume */}
          <IBtn onClick={() => setMuted(!muted)} aria={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇' : volume > 0.5 ? '🔊' : '🔉'}
          </IBtn>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = Number(e.target.value)
              setVolume(v)
              setMuted(v === 0)
            }}
            style={{ width: 72, accentColor: 'var(--color-accent)' }}
            aria-label="Volume"
          />

          {/* Live badge */}
          {kind === 'live' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
              <span className="live-dot" />
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--color-live)', textTransform: 'uppercase', letterSpacing: 1 }}>Live</span>
            </div>
          )}

          <div style={{ flex: 1 }} />

          {/* Stats toggle */}
          <IBtn onClick={() => setShowStats((s) => !s)} aria="Stats" title="Stats (i)">ℹ</IBtn>

          {/* PiP */}
          {document?.pictureInPictureEnabled && (
            <IBtn onClick={() => void togglePip()} aria="Picture-in-picture" title="PiP">
              {pip ? '🗗' : '🗗'}
            </IBtn>
          )}

          {/* Fullscreen */}
          <IBtn onClick={toggleFullscreen} aria="Fullscreen" title="Fullscreen (f)">⛶</IBtn>
        </div>
      </div>
    </div>
  )
}

function IBtn({
  children,
  onClick,
  aria,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  aria: string
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      aria-label={aria}
      title={title}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'white',
        fontSize: 18,
        padding: '4px 6px',
        borderRadius: 6,
        lineHeight: 1,
        transition: 'background 0.12s',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
    >
      {children}
    </button>
  )
}
