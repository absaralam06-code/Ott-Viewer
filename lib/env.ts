import type { HostPolicy } from './proxy'

/**
 * Server configuration. Every accessor is lazy: reading these at module scope would
 * make an unset variable crash the build rather than the request that needs it, and
 * middleware imports this module too.
 */

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

const isProduction = (): boolean => process.env.NODE_ENV === 'production'

export function appPassword(): string {
  const value = optional('APP_PASSWORD')
  if (!value) {
    throw new Error('APP_PASSWORD is not set. Copy .env.example to .env.local and set it.')
  }
  return value
}

/**
 * In development a missing secret is derived from the password so the app runs
 * straight after `cp .env.example .env.local`. In production both secrets must be
 * set explicitly — a derived one would be guessable from the password.
 */
function secret(name: string, devSalt: string): string {
  const value = optional(name)
  if (value) return value
  if (isProduction()) {
    throw new Error(`${name} is not set. Generate one with: openssl rand -hex 32`)
  }
  return `dev:${devSalt}:${optional('APP_PASSWORD') ?? 'ott'}`
}

export function sessionSecret(): string {
  return secret('SESSION_SECRET', 'session')
}

export function proxySecret(): string {
  return secret('PROXY_SECRET', 'proxy')
}

export function allowedStreamHosts(): string[] {
  const raw = optional('ALLOWED_STREAM_HOSTS')
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function allowPrivateStreamHosts(): boolean {
  const raw = optional('ALLOW_PRIVATE_STREAM_HOSTS')
  return raw === '1' || raw?.toLowerCase() === 'true'
}

export function hostPolicy(): HostPolicy {
  return { allowList: allowedStreamHosts(), allowPrivate: allowPrivateStreamHosts() }
}
