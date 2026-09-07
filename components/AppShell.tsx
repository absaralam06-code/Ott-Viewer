'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAppStore } from '@/lib/store'

const NAV = [
  { href: '/', label: 'Home', icon: '🏠' },
  { href: '/live', label: 'Live TV', icon: '📡' },
  { href: '/movies', label: 'Movies', icon: '🎬' },
  { href: '/series', label: 'Series', icon: '🎭' },
  { href: '/guide', label: 'Guide', icon: '📋' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
]

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)

  const isWatch = pathname.startsWith('/watch/')

  async function signOut() {
    setSigningOut(true)
    await fetch('/api/auth', { method: 'DELETE' })
    router.push('/login')
    router.refresh()
  }

  if (isWatch) return <>{children}</>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      {/* Top nav */}
      <header
        className="glass"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          borderLeft: 'none',
          borderRight: 'none',
          borderTop: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0 1rem',
          height: 56,
        }}
      >
        {/* Logo */}
        <Link
          href="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            fontWeight: 800,
            fontSize: '1.1rem',
            color: 'var(--color-text)',
            marginRight: '0.5rem',
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
            }}
          >
            📺
          </span>
          <span style={{ display: 'none' }} className="sm:block">OTT</span>
        </Link>

        {/* Nav links for desktop */}
        <nav className="desktop-only" style={{ gap: '2px', flex: 1 }}>
          {NAV.map(({ href, label, icon }) => {
            const active =
              href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={`nav-link${active ? ' active' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.35rem 0.65rem',
                  borderRadius: 'var(--radius-sm)',
                  textDecoration: 'none',
                  fontSize: '0.875rem',
                  fontWeight: active ? 600 : 400,
                  background: active ? 'var(--color-accent-dim)' : 'transparent',
                  transition: 'background 0.15s, color 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ fontSize: 14 }}>{icon}</span>
                <span>{label}</span>
              </Link>
            )
          })}
        </nav>

        <div style={{ flex: 1 }} className="mobile-only" />

        {/* Sign-out */}
        <button
          onClick={signOut}
          disabled={signingOut}
          className="btn-ghost"
          style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', flexShrink: 0 }}
        >
          {signingOut ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Sign out'}
        </button>
      </header>

      {/* Main */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingBottom: 'calc(56px + env(safe-area-inset-bottom, 0px))' }}>
        {children}
      </main>

      {/* Mobile Bottom Nav Bar */}
      <nav
        className="glass mobile-only"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 'calc(56px + env(safe-area-inset-bottom, 0px))',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: 50,
          borderLeft: 'none',
          borderRight: 'none',
          borderBottom: 'none',
          background: 'rgba(10, 14, 26, 0.95)',
          backdropFilter: 'blur(16px)',
        }}
      >
        {NAV.map(({ href, label, icon }) => {
          const active =
            href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                textDecoration: 'none',
                color: active ? 'var(--color-accent-hover)' : 'var(--color-text-muted)',
                fontSize: '0.68rem',
                fontWeight: active ? 600 : 400,
                padding: '4px 8px',
                flex: 1,
                transition: 'color 0.15s',
              }}
            >
              <span style={{ fontSize: 18 }}>{icon}</span>
              <span>{label}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
