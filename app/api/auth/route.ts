import { NextResponse } from 'next/server'
import { appPassword, sessionSecret } from '@/lib/env'
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sign-in. A public deployment is reachable by anyone who finds the URL, so failed
 * attempts are throttled per client address — without it the single shared password
 * is one long unmetered guessing session.
 */

const WINDOW_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 10
const attempts = new Map<string, { count: number; firstAt: number }>()

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

function tooManyAttempts(key: string): boolean {
  const record = attempts.get(key)
  if (!record) return false
  if (Date.now() - record.firstAt > WINDOW_MS) {
    attempts.delete(key)
    return false
  }
  return record.count >= MAX_ATTEMPTS
}

function recordFailure(key: string): void {
  const record = attempts.get(key)
  if (!record || Date.now() - record.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() })
    return
  }
  record.count++
}

/** Constant-time compare so the response time does not leak the password prefix. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function POST(request: Request) {
  const key = clientKey(request)
  if (tooManyAttempts(key)) {
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429 },
    )
  }

  let password: unknown
  try {
    password = ((await request.json()) as { password?: unknown }).password
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  let expected: string
  try {
    expected = appPassword()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Server is not configured.' },
      { status: 500 },
    )
  }

  if (typeof password !== 'string' || !safeEqual(password, expected)) {
    recordFailure(key)
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 })
  }

  attempts.delete(key)
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, await createSessionToken(sessionSecret()), sessionCookieOptions())
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 })
  return response
}
