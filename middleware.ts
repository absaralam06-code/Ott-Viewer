import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySessionToken } from './lib/session'
import { sessionSecret } from './lib/env'

/**
 * Everything is behind the password except the login page and the auth endpoint.
 *
 * This matters more than it looks: `/api/stream` will relay any correctly signed
 * URL, so leaving it open would turn a public deployment into a third-party proxy
 * for whoever finds it.
 */

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/stream', '/api/license']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next()
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (await verifySessionToken(token, sessionSecret())) {
    return NextResponse.next()
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search =
    pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`
  return NextResponse.redirect(login)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
}
