import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const targetUrl = searchParams.get('url')
  if (!targetUrl) {
    return NextResponse.json({ error: 'License url is required' }, { status: 400 })
  }

  try {
    const body = await request.arrayBuffer()
    const upstreamRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)',
        'Origin': 'https://www.hotstar.com',
        'Referer': 'https://www.hotstar.com/',
      },
      body,
    })

    const data = await upstreamRes.arrayBuffer()
    return new NextResponse(data, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
      },
    })
  } catch {
    return NextResponse.json({ error: 'License request failed' }, { status: 502 })
  }
}
