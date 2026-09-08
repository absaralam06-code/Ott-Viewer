import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const preferredRegion = 'bom1'

export async function GET() {
  const url = 'https://livetv.hotstar.com/mp2/gec-india-1540073624/4a56d383d1074f3d908a7f9b7a3321f1/index.mpd'
  const cookie = 'hdntl=exp=1788915321~acl=%2f*~id=ce664760244f5188245a9776e013484c~data=hdntl~hmac=9d524a5d966a435827bddc85ca40839fc4c6041f4858bad384fe34a152b348e0'
  const userAgent = 'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'
  const referer = 'https://www.hotstar.com/'
  const origin = 'https://www.hotstar.com'

  const results: Record<string, unknown> = {}

  // Test 1: Exactly as buildUpstreamHeaders does right now (with x-forwarded-for)
  try {
    const res1 = await fetch(url, {
      headers: {
        'user-agent': userAgent,
        'accept': '*/*',
        'accept-encoding': 'identity',
        'referer': referer,
        'origin': origin,
        'cookie': cookie,
        'x-forwarded-for': '49.37.10.20',
        'x-real-ip': '49.37.10.20',
      },
    })
    const text1 = await res1.text()
    results.test1_current = {
      status: res1.status,
      headers: Object.fromEntries(res1.headers.entries()),
      body: text1.slice(0, 300),
    }
  } catch (e: unknown) {
    results.test1_current = { error: String(e) }
  }

  // Test 2: WITHOUT x-forwarded-for / x-real-ip
  try {
    const res2 = await fetch(url, {
      headers: {
        'user-agent': userAgent,
        'accept': '*/*',
        'referer': referer,
        'origin': origin,
        'cookie': cookie,
      },
    })
    const text2 = await res2.text()
    results.test2_no_xff = {
      status: res2.status,
      headers: Object.fromEntries(res2.headers.entries()),
      body: text2.slice(0, 300),
    }
  } catch (e: unknown) {
    results.test2_no_xff = { error: String(e) }
  }

  // Test 3: Segment without x-forwarded-for
  const segUrl = 'https://livetv.hotstar.com/mp2/gec-india-1540073624/4a56d383d1074f3d908a7f9b7a3321f1/index_video_7_0_init.mp4?m=1782982698'
  try {
    const res3 = await fetch(segUrl, {
      headers: {
        'user-agent': userAgent,
        'accept': '*/*',
        'referer': referer,
        'origin': origin,
        'cookie': cookie,
      },
    })
    results.test3_segment_no_xff = {
      status: res3.status,
      headers: Object.fromEntries(res3.headers.entries()),
    }
  } catch (e: unknown) {
    results.test3_segment_no_xff = { error: String(e) }
  }

  return NextResponse.json(results)
}
