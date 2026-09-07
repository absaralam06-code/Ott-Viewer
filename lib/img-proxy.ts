/** Encode a logo/poster URL for use with the /api/img proxy. */
export function imgProxyUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  return `/api/img?u=${Buffer.from(rawUrl, 'utf8').toString('base64url')}`
}

/**
 * Client-safe version (no Buffer). Used in `'use client'` components.
 * base64url-encodes the URL using btoa after percent-encoding.
 */
export function imgProxyUrlClient(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const b64 = btoa(encodeURIComponent(rawUrl).replace(/%([0-9A-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    ))
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `/api/img?u=${b64url}`
  } catch {
    return undefined
  }
}

import type { StreamHeaders } from './types'

export interface SignedStreamResult {
  src: string
  ticket?: { t: string; ts: string }
}

/** Sign a stream URL via /api/sign. Result is a /api/stream?… URL and a session ticket. */
export async function signStreamUrl(
  url: string,
  headers?: StreamHeaders,
): Promise<SignedStreamResult> {
  const res = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, headers }),
  })
  if (!res.ok) throw new Error(`Failed to sign stream URL: ${res.status}`)
  return (await res.json()) as SignedStreamResult
}
