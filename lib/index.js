/**
 * Desktop fat-fish pet — host half.
 *
 * It owns exactly one job: publish this package's `assets/` directory over the
 * loopback HTTP carrier the Web GUI is already loaded from, so the client half
 * can hand real same-origin URLs to `<video>`.
 *
 * Why a route at all: the built-in frontend dist server only serves the built
 * shell, and its answers carry `Content-Length` without byte-range support.
 * A media element needs ranges — Chromium issues one whenever it seeks or
 * restarts a loop — so the pet ships its own tiny static route.
 *
 * Why this cannot affect normal harness use:
 *   - read-only: the route only ever reads, and only files named by the strict
 *     allow-list below (`^[A-Za-z0-9_-]+\.(webm|json)$`, resolved inside
 *     `assets/`); no request input is ever joined onto a path;
 *   - no timer, no socket of its own, no child process, no outbound request;
 *   - the only other contribution is one `<script>` tag injected into the
 *     served index, carrying the route base;
 *   - everything is registered under `ctx.effect`, so disposing the plugin
 *     releases the route and the index tap completely.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Shared with the client half; the two halves are installed together. */
const ROUTE_PREFIX = '/dsh-pet'

/** Where the browser reads the asset base from. Injected into the index HTML. */
const GLOBAL_KEY = '__DSH_PET__'

/** Bumped when the asset set changes, so a cached page can notice. */
const ASSET_VERSION = 1

// This file lives in `lib/`, so the package root is one level up. Getting this
// wrong is silent: every asset lookup 404s while the route itself works fine.
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Strict allow-list shape: a bare file name, never a path. */
const ASSET_NAME = /^[A-Za-z0-9_-]+\.(webm|json|png)$/

const CONTENT_TYPES = new Map([
  ['webm', 'video/webm'],
  ['json', 'application/json; charset=utf-8'],
  ['png', 'image/png'],
])

/** One hour: long enough to keep a looping clip off the disk. */
const CACHE_CONTROL = 'public, max-age=3600'

/**
 * @param {import('node:http').ServerResponse} res
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * Single-range parser for `bytes=` requests (RFC 9110).
 * @returns {{ start: number, end: number } | 'invalid' | null}
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || header.length === 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end }
}

/** @param {import('node:http').ServerResponse} res */
function unsupportedRange(res, size) {
  res.writeHead(416, {
    'Content-Range': `bytes */${size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  res.end()
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function serveAsset(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' })
    res.end()
    return
  }

  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    sendJson(res, 400, { error: 'bad-request' })
    return
  }

  const raw = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
  // `basename` collapses any traversal attempt to a bare name, and the regex
  // then rejects anything that is not a plain asset file name.
  const name = basename(decodeURIComponent(raw))
  if (!ASSET_NAME.test(name)) {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  const extension = name.slice(name.lastIndexOf('.') + 1)
  const contentType = CONTENT_TYPES.get(extension)
  if (contentType === undefined) {
    sendJson(res, 404, { error: 'not-found' })
    return
  }

  const file = join(PACKAGE_DIR, 'assets', name)
  let info
  try {
    info = await stat(file)
  } catch {
    sendJson(res, 404, { error: 'missing-asset', name })
    return
  }
  if (!info.isFile()) {
    sendJson(res, 404, { error: 'not-a-file', name })
    return
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  }

  const ifNoneMatch = req.headers['if-none-match']
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const range = parseRange(req.headers.range, info.size)
  if (range === 'invalid') {
    unsupportedRange(res, info.size)
    return
  }

  const start = range === null ? 0 : range.start
  const end = range === null ? info.size - 1 : range.end
  const status = range === null ? 200 : 206
  headers['Content-Length'] = String(end - start + 1)
  if (range !== null) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`

  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const stream = createReadStream(file, { start, end })
  stream.on('error', () => {
    res.destroy()
  })
  req.on('close', () => {
    stream.destroy()
  })
  stream.pipe(res)
}

/** Host-side defaults. A user can override them in the profile patch. */
const DEFAULT_CONFIG = {
  enabled: true,
  injectBaseIntoIndex: true,
}

export const name = 'dsh-pet'

/** The asset route needs the webserver; nothing else is required. */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, injectBaseIntoIndex?: boolean } | undefined} config
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  if (resolved.enabled === false) return

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          // Returning the promise is what lets the tests await a response; the
          // webserver itself ignores handler return values.
          return serveAsset(req, res).catch(() => {
            if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
            else res.destroy()
          })
        },
      }),
    'dsh-pet: asset route',
  )

  if (resolved.injectBaseIntoIndex === false) return

  const payload = { base: ROUTE_PREFIX, assetVersion: ASSET_VERSION }
  const script = `<script>window.${GLOBAL_KEY}=${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`
  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) =>
        html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`,
      ),
    'dsh-pet: index base',
  )
}
