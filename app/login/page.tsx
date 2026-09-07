'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isPending, startTransition] = useTransition()

  const submit = () => {
    setError('')
    startTransition(async () => {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        const params = new URLSearchParams(window.location.search)
        router.push(params.get('next') ?? '/')
        router.refresh()
      } else {
        const data = (await res.json()) as { error?: string }
        setError(data.error ?? 'Incorrect password.')
      }
    })
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(ellipse at 50% 30%, #1e3a5f 0%, #0a0e1a 60%)',
        padding: '1rem',
      }}
    >
      {/* Background grid */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(59,130,246,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.04) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          pointerEvents: 'none',
        }}
      />
      <div
        className="glass scale-in"
        style={{
          width: '100%',
          maxWidth: 420,
          borderRadius: 'var(--radius-xl)',
          padding: '2.5rem',
          position: 'relative',
        }}
      >
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 'var(--radius-lg)',
              background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem',
              fontSize: 28,
              boxShadow: '0 8px 32px rgba(59,130,246,0.4)',
            }}
          >
            📺
          </div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0, color: 'var(--color-text)' }}>
            OTT Player
          </h1>
          <p style={{ color: 'var(--color-text-muted)', margin: '0.4rem 0 0', fontSize: '0.9rem' }}>
            Enter your password to continue
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        >
          <input
            id="password"
            type="password"
            className="input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />

          {error && (
            <div
              style={{
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: '#fca5a5',
                borderRadius: 'var(--radius-md)',
                padding: '0.6rem 0.9rem',
                fontSize: '0.875rem',
              }}
            >
              {error}
            </div>
          )}

          <button
            id="login-btn"
            type="submit"
            className="btn-primary"
            disabled={isPending || !password}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44 }}
          >
            {isPending ? <span className="spinner" style={{ width: 18, height: 18 }} /> : null}
            {isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
