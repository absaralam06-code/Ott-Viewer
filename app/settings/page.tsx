'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import {
  listPlaylists,
  savePlaylist,
  deletePlaylist,
  replaceChannels,
  listEpgSources,
  clearEpg,
  recordEpgSource,
  putProgrammes,
  tvgIdsFor,
} from '@/lib/db'
import { classifyEntries } from '@/lib/classify'
import { useAppStore } from '@/lib/store'
import type { Playlist } from '@/lib/types'

interface ParseResult {
  entries: import('@/lib/types').PlaylistEntry[]
  counts: { live: number; movie: number; series: number }
  title?: string
  epgUrls?: string[]
  suggestXtream?: import('@/lib/types').XtreamCredentials
  userInfo?: unknown
}

export default function SettingsPage() {
  const router = useRouter()
  const { activePlaylistId, setActivePlaylistId } = useAppStore()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [epgSources, setEpgSources] = useState<{ url: string; refreshedAt: number; programmes: number }[]>([])
  const [activeTab, setActiveTab] = useState<'playlists' | 'epg' | 'about'>('playlists')

  // Add playlist state
  const [addMode, setAddMode] = useState<'url' | 'xtream' | 'file'>('url')
  const [m3uUrl, setM3uUrl] = useState('')
  const [xtHost, setXtHost] = useState('')
  const [xtUser, setXtUser] = useState('')
  const [xtPass, setXtPass] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ written: number; total: number } | null>(null)
  const [importError, setImportError] = useState('')
  const [importSuccess, setImportSuccess] = useState('')

  // EPG state
  const [epgUrl, setEpgUrl] = useState('')
  const [epgLoading, setEpgLoading] = useState(false)
  const [epgError, setEpgError] = useState('')
  const [epgStats, setEpgStats] = useState<{ count: number; skipped: number } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const reload = async () => {
    const ps = await listPlaylists()
    setPlaylists(ps)
    const es = await listEpgSources()
    setEpgSources(es)
  }

  useEffect(() => { void reload() }, [])

  // --- Playlist import ---
  const handleImport = async () => {
    setImporting(true)
    setImportError('')
    setImportSuccess('')
    setImportProgress(null)

    try {
      const body: Record<string, unknown> =
        addMode === 'url'
          ? { kind: 'm3u-url', url: m3uUrl.trim().replace(/\.+$/, '') }
          : addMode === 'file'
          ? { kind: 'm3u-file', content: fileContent }
          : { kind: 'xtream', host: xtHost, username: xtUser, password: xtPass }

      const res = await fetch('/api/playlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const d = (await res.json()) as { error?: string }
        throw new Error(d.error ?? 'Import failed.')
      }

      const data = (await res.json()) as ParseResult
      const id = crypto.randomUUID()
      const title =
        data.title ??
        ((addMode === 'url' ? m3uUrl : addMode === 'file' ? fileName : xtHost) ||
        'My Playlist')

      const source =
        addMode === 'xtream'
          ? { kind: 'xtream' as const, xtream: { host: xtHost, username: xtUser, password: xtPass } }
          : addMode === 'file'
          ? { kind: 'm3u-file' as const }
          : { kind: 'm3u-url' as const, url: m3uUrl }

      const playlist: Playlist = {
        id,
        title,
        source,
        epgUrls: data.epgUrls ?? [],
        addedAt: Date.now(),
        refreshedAt: Date.now(),
        counts: data.counts,
      }

      await savePlaylist(playlist)
      await replaceChannels(id, data.entries, (written, total) =>
        setImportProgress({ written, total }),
      )

      setActivePlaylistId(id)
      setImportSuccess(`Imported ${data.entries.length.toLocaleString()} channels. (Live: ${data.counts.live}, Movies: ${data.counts.movie}, Series: ${data.counts.series})`)
      await reload()

      // Reset form
      setM3uUrl('')
      setXtHost(''); setXtUser(''); setXtPass('')
      setFileContent(''); setFileName('')
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.')
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this playlist and all its channels?')) return
    await deletePlaylist(id)
    if (activePlaylistId === id) setActivePlaylistId(null)
    await reload()
  }

  // --- EPG import ---
  const handleEpgImport = async () => {
    if (!epgUrl.trim() || !activePlaylistId) return
    setEpgLoading(true)
    setEpgError('')
    setEpgStats(null)

    try {
      const tvgIds = await tvgIdsFor(activePlaylistId)
      const res = await fetch('/api/epg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: epgUrl.trim(), channelIds: tvgIds }),
      })
      if (!res.ok || !res.body) throw new Error('EPG request failed.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const batch: import('@/lib/types').Programme[] = []
      let count = 0
      let skipped = 0

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line) as { t: string; count?: number; skipped?: number; [k: string]: unknown }
            if (obj.t === 'p') {
              batch.push(obj as unknown as import('@/lib/types').Programme)
              if (batch.length >= 4000) {
                await putProgrammes([...batch])
                batch.length = 0
              }
            } else if (obj.t === 'end') {
              count = obj.count ?? 0
              skipped = obj.skipped ?? 0
            }
          } catch { /* skip bad lines */ }
        }
      }
      if (batch.length) await putProgrammes(batch)
      await recordEpgSource(epgUrl.trim(), count)
      setEpgStats({ count, skipped })
      setEpgUrl('')
      await reload()
    } catch (e) {
      setEpgError(e instanceof Error ? e.message : 'EPG import failed.')
    } finally {
      setEpgLoading(false)
    }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '1.5rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '1.5rem' }}>⚙️ Settings</h1>

        {/* Tab row */}
        <div className="tab-row" style={{ marginBottom: '1.5rem' }}>
          {(['playlists', 'epg', 'about'] as const).map((t) => (
            <button key={t} className={`tab-btn${activeTab === t ? ' active' : ''}`} onClick={() => setActiveTab(t)}>
              {t === 'playlists' ? '📋 Playlists' : t === 'epg' ? '🗓 EPG Sources' : 'ℹ About'}
            </button>
          ))}
        </div>

        {/* Playlists tab */}
        {activeTab === 'playlists' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Add playlist */}
            <section className="glass" style={{ borderRadius: 'var(--radius-lg)', padding: '1.25rem' }}>
              <div className="section-heading" style={{ marginBottom: '1rem' }}>Add Playlist</div>

              <div className="tab-row" style={{ marginBottom: '1rem' }}>
                {(['url', 'xtream', 'file'] as const).map((m) => (
                  <button key={m} className={`tab-btn${addMode === m ? ' active' : ''}`} onClick={() => setAddMode(m)}>
                    {m === 'url' ? '🔗 M3U URL' : m === 'xtream' ? '🔑 Xtream' : '📁 File'}
                  </button>
                ))}
              </div>

              {addMode === 'url' && (
                <input className="input" placeholder="https://provider.com/playlist.m3u" value={m3uUrl} onChange={(e) => setM3uUrl(e.target.value)} />
              )}

              {addMode === 'xtream' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input className="input" placeholder="http://provider.com:8080" value={xtHost} onChange={(e) => setXtHost(e.target.value)} />
                  <input className="input" placeholder="Username" value={xtUser} onChange={(e) => setXtUser(e.target.value)} />
                  <input className="input" type="password" placeholder="Password" value={xtPass} onChange={(e) => setXtPass(e.target.value)} />
                </div>
              )}

              {addMode === 'file' && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".m3u,.m3u8"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (!f) return
                      setFileName(f.name)
                      const reader = new FileReader()
                      reader.onload = (ev) => setFileContent(ev.target?.result as string)
                      reader.readAsText(f)
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-ghost" onClick={() => fileInputRef.current?.click()} style={{ flex: 1 }}>
                      {fileName || 'Choose .m3u file…'}
                    </button>
                  </div>
                </div>
              )}

              {importError && (
                <div style={{ marginTop: 10, padding: '0.6rem 0.9rem', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#fca5a5', fontSize: '0.85rem' }}>
                  {importError}
                </div>
              )}
              {importSuccess && (
                <div style={{ marginTop: 10, padding: '0.6rem 0.9rem', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8, color: '#86efac', fontSize: '0.85rem' }}>
                  {importSuccess}
                </div>
              )}
              {importProgress && (
                <div style={{ marginTop: 10 }}>
                  <div className="progress-bar">
                    <div className="progress-bar-fill" style={{ width: `${(importProgress.written / importProgress.total) * 100}%` }} />
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                    Saving {importProgress.written.toLocaleString()} / {importProgress.total.toLocaleString()} channels…
                  </div>
                </div>
              )}

              <button
                className="btn-primary"
                style={{ marginTop: 12, width: '100%' }}
                disabled={importing || (addMode === 'url' && !m3uUrl) || (addMode === 'xtream' && (!xtHost || !xtUser || !xtPass)) || (addMode === 'file' && !fileContent)}
                onClick={() => void handleImport()}
              >
                {importing ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                    <span className="spinner" style={{ width: 16, height: 16 }} />
                    Importing…
                  </span>
                ) : 'Import Playlist'}
              </button>
            </section>

            {/* Playlist list */}
            {playlists.length > 0 && (
              <section>
                <div className="section-heading" style={{ marginBottom: '0.75rem' }}>My Playlists</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {playlists.map((p) => (
                    <div
                      key={p.id}
                      className="glass"
                      style={{
                        borderRadius: 'var(--radius-md)',
                        padding: '0.9rem 1rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        border: activePlaylistId === p.id ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                          {p.counts.live.toLocaleString()} live · {p.counts.movie.toLocaleString()} movies · {p.counts.series.toLocaleString()} series
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginTop: 1 }}>
                          Added {new Date(p.addedAt).toLocaleDateString()}
                        </div>
                      </div>
                      {activePlaylistId !== p.id && (
                        <button className="btn-ghost" onClick={() => setActivePlaylistId(p.id)} style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}>Use</button>
                      )}
                      {activePlaylistId === p.id && (
                        <span className="chip" style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-hover)' }}>Active</span>
                      )}
                      <button onClick={() => void handleDelete(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: 18, padding: '4px' }} aria-label="Delete playlist">🗑</button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* EPG tab */}
        {activeTab === 'epg' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <section className="glass" style={{ borderRadius: 'var(--radius-lg)', padding: '1.25rem' }}>
              <div className="section-heading" style={{ marginBottom: '1rem' }}>Add XMLTV Source</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" placeholder="https://example.com/guide.xml" value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} style={{ flex: 1 }} />
                <button
                  className="btn-primary"
                  disabled={epgLoading || !epgUrl.trim() || !activePlaylistId}
                  onClick={() => void handleEpgImport()}
                  style={{ flexShrink: 0 }}
                >
                  {epgLoading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Load EPG'}
                </button>
              </div>
              {epgError && <div style={{ marginTop: 8, color: '#fca5a5', fontSize: '0.85rem' }}>{epgError}</div>}
              {epgStats && (
                <div style={{ marginTop: 8, color: '#86efac', fontSize: '0.85rem' }}>
                  Loaded {epgStats.count.toLocaleString()} programmes (skipped {epgStats.skipped.toLocaleString()} out of range).
                </div>
              )}
              {!activePlaylistId && <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>Add a playlist first to filter EPG by its channels.</div>}
            </section>

            {epgSources.length > 0 && (
              <section>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <div className="section-heading">EPG Sources</div>
                  <button className="btn-ghost" style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }} onClick={async () => { await clearEpg(); await reload() }}>
                    Clear all EPG
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {epgSources.map((s) => (
                    <div key={s.url} className="glass" style={{ borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem', fontSize: '0.85rem' }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-accent-hover)' }}>{s.url}</div>
                      <div style={{ color: 'var(--color-text-muted)', marginTop: 2, fontSize: '0.78rem' }}>
                        {s.programmes.toLocaleString()} programmes · refreshed {new Date(s.refreshedAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* About tab */}
        {activeTab === 'about' && (
          <section className="glass" style={{ borderRadius: 'var(--radius-lg)', padding: '1.5rem' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📺</div>
            <h2 style={{ margin: '0 0 8px', fontSize: '1.3rem' }}>OTT Player</h2>
            <p style={{ color: 'var(--color-text-muted)', margin: '0 0 16px', lineHeight: 1.7, fontSize: '0.9rem' }}>
              A web-based IPTV player. Add an M3U URL, Xtream Codes login, or upload a local .m3u file — then browse channels, watch live TV, movies and series, and follow the EPG guide.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.85rem', color: 'var(--color-text-dim)' }}>
              <div>✅ CORS, mixed-content and User-Agent blockers solved by server-side proxy</div>
              <div>✅ HLS via hls.js, MPEG-TS via mpegts.js, MP4 native</div>
              <div>✅ 100k+ channel playlists via IndexedDB + virtualised rendering</div>
              <div>✅ XMLTV guide streaming with NDJSON, filtered by your playlist</div>
              <div>✅ HMAC-signed proxy URLs — no open relay</div>
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn-ghost" onClick={async () => { await fetch('/api/auth', { method: 'DELETE' }); router.push('/login') }}>
                Sign out
              </button>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  )
}
