/**
 * Session cookie signing.
 *
 * Deliberately built on Web Crypto rather than `node:crypto`: this module is imported
 * by `middleware.ts`, which Next runs on the Edge runtime where the Node crypto and
 * Buffer globals do not exist. Web Crypto is present in both runtimes, so one
 * implementation covers middleware and the route handlers.
 */

export const SESSION_COOKIE = 'ott_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return toBase64Url(new Uint8Array(signature))
}

/** Constant-time compare; `crypto.timingSafeEqual` is Node-only. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `<expiry-ms>.<hmac>` — self-contained, so no server-side session store. */
export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const expiry = String(now + SESSION_MAX_AGE_SECONDS * 1000)
  return `${expiry}.${await signPayload(expiry, secret)}`
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expiry = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!/^\d+$/.test(expiry)) return false
  if (!safeEqual(signature, await signPayload(expiry, secret))) return false
  return Number(expiry) > now
}

export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}
