# OTT Player

A web-based IPTV app that works like OTT Navigator: add a playlist (M3U URL, Xtream Codes login, or local `.m3u` upload) and get a full browsable streaming interface — live TV with group sidebar, EPG guide timeline, movies and series sections, search, and favorites.

## Why a server-side proxy is the whole point

A browser cannot play a typical IPTV playlist directly. Three hard blockers, all solved in one place (`app/api/stream/route.ts`):

1. **CORS** — provider endpoints send no `Access-Control-Allow-Origin`.
2. **Mixed content** — most IPTV providers are plain HTTP; an HTTPS page cannot load them at all.
3. **Forbidden headers** — many providers need a specific `User-Agent` or `Referer`; scripts cannot set `User-Agent`.

The proxy also rewrites every HLS manifest so that child playlist and segment URLs are replaced with signed `/api/stream?…` URLs. Relative paths are resolved against the **final** URL after redirects.

## Stack

| | |
|---|---|
| Framework | Next.js 15 (App Router) + TypeScript |
| Styling | Tailwind v4 CSS variables |
| HLS playback | hls.js |
| MPEG-TS live | mpegts.js |
| Storage | IndexedDB via `idb` |
| Big lists | @tanstack/react-virtual |
| State | Zustand |

## Quick start (local)

```bash
# 1. Copy env and set a password
cp .env.example .env.local
# Edit .env.local — set APP_PASSWORD at minimum

# 2. Install
npm install

# 3. Run dev server
npm run dev
# → http://localhost:3000
```

Sign in at `/login`, then go to **Settings → Add Playlist**.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `APP_PASSWORD` | **Yes** | Single shared password for the login gate |
| `SESSION_SECRET` | Prod only | 32-byte hex secret for session cookies — `openssl rand -hex 32` |
| `PROXY_SECRET` | Prod only | 32-byte hex secret for HMAC-signed proxy URLs |
| `ALLOWED_STREAM_HOSTS` | Optional | Comma-separated hostnames the proxy may fetch (empty = any public host) |
| `ALLOW_PRIVATE_STREAM_HOSTS` | Optional | Set to `1` for LAN IPTV; **never** on a public deployment |

In development, `SESSION_SECRET` and `PROXY_SECRET` are derived from `APP_PASSWORD`, so only `APP_PASSWORD` is needed.

## Production deploy

### Long-running Node host (recommended)

```bash
npm run build
APP_PASSWORD=... SESSION_SECRET=... PROXY_SECRET=... npm start
```

Raw MPEG-TS live streams are infinite responses. Serverless functions (Vercel, etc.) will cut them at the function-duration cap. HLS channels are unaffected — each segment is one short request. If your provider only serves `.ts` streams, use a persistent host.

### Docker (Fly.io / Railway / VPS)

```bash
docker build -t ott .
docker run -p 3000:3000 \
  -e APP_PASSWORD=... \
  -e SESSION_SECRET=... \
  -e PROXY_SECRET=... \
  ott
```

## Available pages

| Path | Description |
|---|---|
| `/login` | Password gate |
| `/` | Home: continue watching, favorites, group tiles |
| `/live` | Virtualised channel list with group sidebar, search, favorites |
| `/movies` | Poster grid for VOD |
| `/series` | Show grid → season/episode drill-down |
| `/guide` | EPG timeline with ±1h navigation and now-line |
| `/watch/[id]` | Full-screen player with zapping sidebar and now/next |
| `/settings` | Add/delete playlists, import XMLTV EPG |

## Player keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `k` | Play / Pause |
| `←` / `→` | Seek ±10s (VOD) |
| `↑` / `↓` | Previous / Next channel |
| `f` | Fullscreen |
| `m` | Mute / Unmute |
| `i` | Toggle stats overlay |
| `Esc` | Exit fullscreen |

## Running tests

```bash
npm test
# 66 tests across m3u, classify, xmltv, proxy, session, xtream parsers
```

Tests use Node's built-in `node:test` runner with `--experimental-strip-types`, so no test-framework install is needed beyond Node 22.

## Security

- Every proxied stream URL is HMAC-signed with `PROXY_SECRET`. An unsigned URL is 403'd.
- Logo images go through `/api/img` (session-gated, private-address screened).
- The session cookie is `httpOnly`, `SameSite=Lax`, and `Secure` in production.
- SSRF guard: the proxy resolves every hostname and rejects loopback, link-local and RFC-1918 ranges — re-checked after every redirect.
- Provider credentials (Xtream host/user/pass) stay in the browser's IndexedDB; they are never logged or stored server-side.
